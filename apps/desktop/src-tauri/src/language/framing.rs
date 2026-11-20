use serde_json::Value;
use std::io::{self, BufRead, Write};

const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADER: usize = 4096;
// An outgoing sync may contain a 2 MiB workspace document. JSON can
// expand each control byte to six characters, plus message metadata.
const MAX_OUTBOUND_BODY: usize = 13 * 1024 * 1024;

pub fn read(input: &mut impl BufRead) -> io::Result<Value> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid LSP frame");
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        if headers.len() == MAX_HEADER {
            return Err(invalid());
        }
        input.read_exact(&mut byte)?;
        headers.push(byte[0]);
    }
    let mut length = None;
    for line in std::str::from_utf8(&headers)
        .map_err(|_| invalid())?
        .trim_end()
        .split("\r\n")
    {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(invalid());
            }
            length = value.trim().parse::<usize>().ok();
            if length.is_none() {
                return Err(invalid());
            }
        }
    }
    let size = length
        .filter(|size| (1..=MAX_BODY).contains(size))
        .ok_or_else(invalid)?;
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    let message: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(invalid());
    }
    Ok(message)
}

pub fn write(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_OUTBOUND_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Oversized LSP frame",
        ));
    }
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_handles_consecutive_frames_and_rejects_bad_lengths() {
        let message = serde_json::json!({"jsonrpc":"2.0","method":"sample","params":{"text":"🦀"}});
        let mut wire = Vec::new();
        write(&mut wire, &message).unwrap();
        write(&mut wire, &message).unwrap();
        let mut input = wire.as_slice();
        assert_eq!(read(&mut input).unwrap(), message);
        assert_eq!(read(&mut input).unwrap(), message);
        for invalid in [
            "Content-Length: 1048577\r\n\r\n",
            "Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
            "Content-Length: 2\r\n\r\n{}",
            "Content-Length: 3\r\n\r\n{",
        ] {
            assert!(read(&mut invalid.as_bytes()).is_err());
        }
    }
}
