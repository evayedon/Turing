use super::{Declaration, IndexedFile, Kind, Result, WorkspaceError};
use regex::Regex;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock,
    },
    time::Instant,
};

const MAX_NAME_BYTES: usize = 128;
const IDENTIFIER: &str = r"[$_\p{XID_Start}][$_\p{XID_Continue}]*";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Language {
    Script,
    Rust,
    Python,
    CFamily,
}

impl Language {
    pub(super) fn for_name(name: &str) -> Option<Self> {
        match name.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some(Self::Script),
            "rs" => Some(Self::Rust),
            "py" | "pyi" => Some(Self::Python),
            "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" | "ixx" | "inl" => {
                Some(Self::CFamily)
            }
            _ => None,
        }
    }

    fn patterns(self) -> &'static [Regex] {
        static SCRIPT: LazyLock<Vec<Regex>> = LazyLock::new(|| {
            compile(&[
                r"^\s*(?:(?:export|default|declare|abstract|async)\s+)*(?<kind>const\s+enum|function|class|interface|enum|namespace|type|const|let|var)\b\s*\*?\s+(?<name>ID)",
                r"^\s*(?:(?:export|default|declare|abstract|async)\s+)*function\s*\*\s*(?<name>ID)",
            ])
        });
        static RUST: LazyLock<Vec<Regex>> = LazyLock::new(|| {
            compile(&[
                r"^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|default|const|extern)\s+)*(?<kind>fn|struct|enum|union|trait|type|mod|const|static|macro_rules!)\s*(?:\b|\s)\s*(?:mut\s+)?(?:r#)?(?<name>ID)",
            ])
        });
        static PYTHON: LazyLock<Vec<Regex>> = LazyLock::new(|| {
            compile(&[
                r"^\s*(?:async\s+)?(?<kind>def|class)\s+(?<name>ID)\s*[\[(:]",
                r"^\s*(?<kind>type)\s+(?<name>ID)\s*[\[=]",
            ])
        });
        static C_FAMILY: LazyLock<Vec<Regex>> = LazyLock::new(|| {
            compile(&[
                r"^\s*#\s*(?<kind>define)\s+(?<name>ID)",
                r"^\s*(?:template\s*<[^;{}]*>\s*)?(?:(?:inline|typedef)\s+)?(?<kind>enum(?:\s+(?:class|struct))?|class|struct|union|namespace)\s+(?<name>ID)\s*(?:[:{;]|$)",
                r"^\s*(?<kind>using)\s+(?<name>ID)\s*=",
                r"^\s*(?<kind>typedef)\s+[^{};()]+\s+(?<name>ID)\s*;",
                r"^\s*(?:template\s*<[^;{}]*>\s*)?(?:ID(?:::ID)*(?:\s*<[^;{}()]*>)?[\s*&]+)+(?:ID::)*(?<name>ID)\s*\([^;{}]*\)\s*(?:(?:const|noexcept|override|final)\s*)*(?:->[^;{}=]+)?(?:[;{]|=\s*(?:0|default|delete)\s*;|$)",
            ])
        });
        match self {
            Self::Script => &SCRIPT,
            Self::Rust => &RUST,
            Self::Python => &PYTHON,
            Self::CFamily => &C_FAMILY,
        }
    }
}

fn compile(patterns: &[&str]) -> Vec<Regex> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(&pattern.replace("ID", IDENTIFIER)).expect("built-in symbol pattern")
        })
        .collect()
}

fn kind(keyword: &str) -> Kind {
    match keyword {
        "class" => Kind::Class,
        "const" => Kind::Constant,
        "function" | "fn" | "def" => Kind::Function,
        "interface" => Kind::Interface,
        "define" | "macro_rules!" => Kind::Macro,
        "mod" | "namespace" => Kind::Module,
        "struct" | "union" => Kind::Struct,
        "trait" => Kind::Trait,
        "type" | "using" | "typedef" => Kind::Type,
        "let" | "var" | "static" => Kind::Variable,
        _ => Kind::Enum,
    }
}

/// Masks comments and literals without shifting byte offsets. The original
/// line is used for the UTF-16 position, including non-ASCII masked text.
#[derive(Default)]
struct Mask {
    block_depth: usize,
    literal_end: Vec<u8>,
    raw: bool,
}

impl Mask {
    fn line(&mut self, language: Language, source: &str) -> String {
        let bytes = source.as_bytes();
        let mut masked = bytes.to_vec();
        let mut i = 0;
        while i < bytes.len() {
            let rest = &bytes[i..];
            let width = if self.block_depth > 0 {
                if rest.starts_with(b"*/") {
                    self.block_depth -= 1;
                    2
                } else if language == Language::Rust && rest.starts_with(b"/*") {
                    self.block_depth += 1;
                    2
                } else {
                    1
                }
            } else if !self.literal_end.is_empty() {
                if rest.starts_with(&self.literal_end) {
                    let width = self.literal_end.len();
                    self.literal_end.clear();
                    width
                } else if !self.raw && rest[0] == b'\\' {
                    rest.len().min(2)
                } else {
                    1
                }
            } else if (language == Language::Python && rest[0] == b'#')
                || (language != Language::Python && rest.starts_with(b"//"))
            {
                rest.len()
            } else if language != Language::Python && rest.starts_with(b"/*") {
                self.block_depth = 1;
                2
            } else if let Some((width, end, raw)) = literal(language, rest) {
                self.literal_end = end;
                self.raw = raw;
                width
            } else {
                i += 1;
                continue;
            };
            masked[i..i + width].fill(b' ');
            i += width;
        }
        if language != Language::Rust
            && matches!(self.literal_end.as_slice(), b"\"" | b"'")
            && !source.ends_with('\\')
        {
            self.literal_end.clear();
        }
        // All edits replace complete non-ASCII sequences in masked regions.
        String::from_utf8(masked).unwrap_or_default()
    }
}

fn literal(language: Language, rest: &[u8]) -> Option<(usize, Vec<u8>, bool)> {
    if language == Language::Rust && rest[0] == b'r' {
        let hashes = rest[1..].iter().take_while(|&&b| b == b'#').count();
        if hashes <= 255 && rest.get(1 + hashes) == Some(&b'"') {
            let mut end = vec![b'#'; 1 + hashes];
            end[0] = b'"';
            return Some((2 + hashes, end, true));
        }
    }
    if language == Language::CFamily && rest.starts_with(b"R\"") {
        let delimiter = &rest[2..];
        if let Some(length) = delimiter.iter().take(17).position(|&b| b == b'(') {
            let mut end = vec![b')'];
            end.extend_from_slice(&delimiter[..length]);
            end.push(b'"');
            return Some((3 + length, end, true));
        }
    }
    let quote = rest[0];
    if quote == b'\'' && language == Language::Rust {
        // A lifetime or label begins with the same byte as a character literal.
        let first = *rest.get(1)?;
        let continuation = rest[2..]
            .iter()
            .take_while(|&&byte| byte & 0xc0 == 0x80)
            .count();
        if first != b'\\' && rest.get(2 + continuation) != Some(&b'\'') {
            return None;
        }
    }
    if matches!(quote, b'"' | b'\'') || (quote == b'`' && language == Language::Script) {
        let width = if language == Language::Python && rest.starts_with(&[quote; 3]) {
            3
        } else {
            1
        };
        return Some((width, vec![quote; width], false));
    }
    None
}

pub(super) const MAX_LINE_BYTES: usize = 16 * 1024;

pub(super) fn declarations(
    language: Language,
    text: &str,
    limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<IndexedFile> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut slice_started = Instant::now();
    let mut mask = Mask::default();
    let mut file = IndexedFile {
        declarations: Vec::new(),
        truncated: false,
    };
    for (line, source) in text
        .split('\n')
        .flat_map(|line| line.strip_suffix('\r').unwrap_or(line).split('\r'))
        .enumerate()
    {
        if Instant::now().duration_since(slice_started) >= super::SLICE_TIME {
            std::thread::park_timeout(super::SLICE_PAUSE);
            slice_started = Instant::now();
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(WorkspaceError::SearchCancelled);
        }
        if Instant::now() >= deadline || source.len() > MAX_LINE_BYTES {
            file.truncated = true;
            break;
        }
        let masked = mask.line(language, source);
        let Some(captures) = language
            .patterns()
            .iter()
            .find_map(|pattern| pattern.captures(&masked))
        else {
            continue;
        };
        let Some(name) = captures.name("name") else {
            continue;
        };
        let kind = match captures.name("kind") {
            Some(keyword) => kind(keyword.as_str()),
            None if language == Language::CFamily => {
                let prefix = masked[..name.start()].trim_start();
                if matches!(
                    prefix.split_whitespace().next(),
                    Some(
                        "return"
                            | "co_return"
                            | "throw"
                            | "new"
                            | "delete"
                            | "case"
                            | "else"
                            | "if"
                    )
                ) {
                    continue;
                }
                Kind::Function
            }
            None => Kind::Function,
        };
        if name.len() > MAX_NAME_BYTES {
            file.truncated = true;
            continue;
        }
        if file.declarations.len() == limit {
            file.truncated = true;
            break;
        }
        file.declarations.push(Declaration {
            name: name.as_str().to_owned(),
            folded: name.as_str().to_lowercase(),
            kind,
            line,
            character: source[..name.start()].encode_utf16().count(),
        });
    }
    Ok(file)
}
