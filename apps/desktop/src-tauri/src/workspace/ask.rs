mod index;
pub(super) use index::Index;
pub(crate) use index::{IndexAction, IndexStatus};

use super::{
    search::{self, Walk},
    Registry, Result,
};
use crate::{ask::Source, language::AskSymbol};
use cap_std::fs::Dir;
use regex::RegexSet;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const FILE_BYTES: u64 = 256 * 1024;
const MAX_PASSAGES: usize = 8;
const PASSAGE_LINES: usize = 12;

pub(crate) struct Passage {
    pub source: Source,
    pub text: String,
    pub(crate) score: usize,
}

pub(crate) struct Retrieval {
    pub passages: Vec<Passage>,
    pub partial: bool,
}

impl Registry {
    pub(crate) fn ask_root(&self, owner: &str, workspace_id: &str) -> Result<Dir> {
        self.language_root(owner, workspace_id)?;
        Ok(self.authorize(owner, workspace_id)?.try_clone()?)
    }
}

/// Editor lines: CRLF, LF, and lone CR all end a line, as in Monaco.
pub(crate) fn lines(content: &str) -> Vec<&str> {
    content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .split('\n')
        .flat_map(|line| line.strip_suffix('\r').unwrap_or(line).split('\r'))
        .collect()
}

/// `symbols` come from already-running language servers and only add a
/// definition bonus to the block holding their start line; passage text is
/// always read from the authorized workspace.
pub(crate) fn retrieve(
    root: &Dir,
    question: &str,
    symbols: &[AskSymbol],
    cancelled: &AtomicBool,
) -> Result<Retrieval> {
    let mut scan = make_scan(question, symbols, cancelled)?;
    scan.visit(root, &mut Vec::new())?;
    Ok(scan.finish())
}

/// Lowercased question words that ranking looks for, in question order.
pub(crate) fn terms(question: &str) -> Vec<String> {
    let mut words = Vec::new();
    for word in question.split(|ch: char| !ch.is_alphanumeric() && ch != '_') {
        let word = word.to_lowercase();
        if word.len() >= 3
            && ![
                "the", "and", "what", "where", "does", "how", "this", "which", "with", "for",
                "why", "from", "find", "explain",
            ]
            .contains(&word.as_str())
            && !words.contains(&word)
        {
            words.push(word);
        }
        if words.len() == 32 {
            break;
        }
    }
    words
}

fn make_scan<'a>(
    question: &str,
    symbols: &[AskSymbol],
    cancelled: &'a AtomicBool,
) -> Result<Scan<'a>> {
    let words = terms(question);
    let mut defined: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for symbol in symbols {
        let name = symbol.name.to_lowercase();
        if let Some(word) = words.iter().position(|word| *word == name) {
            defined
                .entry(symbol.path.clone())
                .or_default()
                .push((symbol.line / PASSAGE_LINES, word));
        }
    }
    let terms = RegexSet::new(
        words
            .iter()
            .map(|word| format!(r"(?i)\b{}\b", regex::escape(word))),
    )
    .map_err(|_| super::WorkspaceError::InvalidSearch)?;
    // Keyword-introduced definitions only (no C-style `int name(`); running language servers cover the rest.
    let definitions = RegexSet::new(words.iter().map(|word| {
        format!(
            r"(?im)^[ \t]*(?:(?:pub(?:\([^)\n]*\))?|export|default|async|static|public|private|protected|abstract|final|unsafe|extern|inline|override)[ \t]+)*(?:fn|def|class|struct|enum|trait|interface|type|function|func|impl|mod|module|namespace|const|let|var|val)[ \t]+{}\b",
            regex::escape(word)
        )
    }))
    .map_err(|_| super::WorkspaceError::InvalidSearch)?;
    Ok(Scan {
        retrieval: Retrieval {
            passages: Vec::new(),
            partial: false,
        },
        terms,
        definitions,
        symbols: defined,
        cancelled,
        deadline: Instant::now() + search::MAX_DURATION,
        entries: 0,
        bytes: 0,
    })
}

struct Scan<'a> {
    retrieval: Retrieval,
    terms: RegexSet,
    definitions: RegexSet,
    /// Relative path to (block index, term index) of server-reported definitions.
    symbols: HashMap<String, Vec<(usize, usize)>>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    entries: usize,
    bytes: u64,
}

/// Files that may hold credentials. Shared with the agent policy gate.
pub(crate) fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["secret", "credential", "password", "private"]
        .iter()
        .any(|part| name.contains(part))
        || matches!(name.as_str(), ".env" | ".npmrc" | ".pypirc" | ".netrc")
        || name.starts_with(".env.")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|extension| name.ends_with(extension))
}

/// Directories that may hold credentials. Shared with the agent policy gate.
pub(crate) fn secret_directory(name: &str) -> bool {
    [
        "secret",
        "secrets",
        "credentials",
        "private",
        ".ssh",
        ".aws",
        ".gnupg",
    ]
    .iter()
    .any(|part| name.eq_ignore_ascii_case(part))
}

fn eligible(name: &str) -> bool {
    if secret_name(name) {
        return false;
    }
    let name = name.to_ascii_lowercase();
    if ["generated", "min.js", "min.css", "lock."]
        .iter()
        .any(|part| name.contains(part))
    {
        return false;
    }
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        [
            "rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "cpp", "h", "hpp", "java", "cs", "md",
            "css", "html", "swift", "kt", "rb", "php", "sh",
        ]
        .contains(&extension)
    })
}

pub(crate) fn excluded_content(content: &str) -> bool {
    content.contains('\0')
        || content.contains("PRIVATE KEY-----")
        || content.lines().any(|line| {
            let trimmed = line.trim_start().to_ascii_lowercase();
            [
                "api_key",
                "access_token",
                "password",
                "client_secret",
                "aws_secret_access_key",
            ]
            .iter()
            .any(|prefix| trimmed.starts_with(prefix))
        })
}

fn eligible_directory(name: &str) -> bool {
    !name.starts_with('.')
        && !secret_directory(name)
        && !["vendor", "generated", "out"]
            .iter()
            .any(|part| name.eq_ignore_ascii_case(part))
}

impl Walk for Scan<'_> {
    fn stop(&mut self) -> Result<bool> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(super::WorkspaceError::SearchCancelled);
        }
        let stop = Instant::now() >= self.deadline
            || self.entries >= search::MAX_ENTRIES
            || self.bytes >= search::MAX_SCAN_BYTES - FILE_BYTES - 1;
        self.retrieval.partial |= stop;
        Ok(stop)
    }

    fn count_entry(&mut self) {
        self.entries += 1;
    }
    fn skipped(&mut self) {
        self.retrieval.partial = true;
    }
    fn truncate(&mut self) {
        self.retrieval.partial = true;
    }
    fn descend(&self, name: &str) -> bool {
        eligible_directory(name)
    }

    fn file(&mut self, root: &Dir, directory: &Dir, parents: &[String], name: &str) -> Result<()> {
        if name.starts_with('.') || !eligible(name) {
            return Ok(());
        }
        let Ok(snapshot) =
            search::read_reachable(root, directory, parents, name, FILE_BYTES, &mut self.bytes)
        else {
            self.skipped();
            return Ok(());
        };
        if excluded_content(&snapshot.content) {
            self.skipped();
            return Ok(());
        }
        let path = parents
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(name))
            .collect::<Vec<_>>()
            .join("/");
        self.rank(&path, &snapshot.content, &snapshot.version)
    }
}

impl Scan<'_> {
    fn finish(mut self) -> Retrieval {
        let passages = &mut self.retrieval.passages;
        if passages.iter().any(|passage| passage.score > 0) {
            passages.retain(|passage| passage.score > 0);
        }
        self.retrieval
    }

    fn rank(&mut self, path: &str, content: &str, version: &str) -> Result<()> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let filename = name.replace('.', " ");
        let path_score = self.terms.matches(&filename).iter().count();
        let lines = lines(content);
        for (index, block) in lines.chunks(PASSAGE_LINES).enumerate() {
            if self.stop()? {
                break;
            }
            if block.iter().any(|line| line.len() > 256) {
                continue;
            }
            let text = block.join("\n");
            if text.trim().is_empty() {
                continue;
            }
            let mentioned = self.terms.matches(&text);
            let mut defined: Vec<usize> = self.definitions.matches(&text).into_iter().collect();
            // A server position counts only where the indexed text still names the symbol.
            for &(block, word) in self.symbols.get(path).into_iter().flatten() {
                if block == index && mentioned.matched(word) && !defined.contains(&word) {
                    defined.push(word);
                }
            }
            let score = mentioned.iter().count() * 2
                + defined.len() * 3
                + usize::from(index == 0) * path_score;
            if score == 0 && index != 0 {
                continue;
            }
            let start_line = index * PASSAGE_LINES + 1;
            let passages = &mut self.retrieval.passages;
            passages.push(Passage {
                source: Source {
                    relative_path: path.to_owned(),
                    version: version.to_owned(),
                    start_line,
                    end_line: start_line + block.len() - 1,
                },
                text,
                score,
            });
            passages.sort_unstable_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then(a.source.relative_path.cmp(&b.source.relative_path))
                    .then(a.source.start_line.cmp(&b.source.start_line))
            });
            if passages.len() > MAX_PASSAGES {
                passages.pop();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn retrieves_versioned_lines_from_authorized_source_files() {
        let fixture = TempDir::new().unwrap();
        let dir = fixture.path();
        fs::write(
            dir.join("settings.rs"),
            "mod defaults;\r\nconst MAX_TABS: usize = 12;\r\n",
        )
        .unwrap();
        for path in [
            ".env",
            "credentials.rs",
            "asset.bin",
            "data.rs",
            "covered.rs",
            "private_key.rs",
            "generated/code.rs",
            "dist/bundle.js",
        ] {
            let path = dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let content = match path.file_name().unwrap().to_str().unwrap() {
                "data.rs" => "MAX_TABS\0",
                "covered.rs" => "MAX_TABS\n-----BEGIN PRIVATE KEY-----",
                _ => "MAX_TABS",
            };
            fs::write(path, content).unwrap();
        }
        let mut registry = Registry::default();
        let workspace = registry.register("workbench", dir).unwrap();
        assert!(registry.ask_root("other", &workspace.id).is_err());
        assert!(registry.ask_root("workbench", "../other").is_err());
        let root = registry.ask_root("workbench", &workspace.id).unwrap();
        let result = retrieve(
            &root,
            "Where is MAX_TABS defined?",
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.passages.len(), 1);
        let passage = &result.passages[0];
        assert_eq!(passage.source.relative_path, "settings.rs");
        assert_eq!((passage.source.start_line, passage.source.end_line), (1, 3));
        assert_eq!(
            passage.text.lines().nth(1),
            Some("const MAX_TABS: usize = 12;")
        );
        assert_eq!(
            passage.source.version,
            registry
                .read("workbench", &workspace.id, "settings.rs")
                .unwrap()
                .version
        );
        assert!(retrieve(&root, "MAX_TABS", &[], &AtomicBool::new(true)).is_err());
        registry.close("workbench", &workspace.id).unwrap();
        assert!(registry.ask_root("workbench", &workspace.id).is_err());
    }

    #[test]
    fn ranks_definitions_above_mentions() {
        let fixture = TempDir::new().unwrap();
        let dir = fixture.path();
        fs::write(dir.join("a_use.rs"), "let limit = retry_limit();\n").unwrap();
        fs::write(
            dir.join("z_def.rs"),
            "pub(crate) fn retry_limit() -> u32 {\n    3\n}\n",
        )
        .unwrap();
        fs::write(dir.join("y_def.py"), "def other():\n    pass\n").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("workbench", dir).unwrap();
        let root = registry.ask_root("workbench", &workspace.id).unwrap();
        let paths: Vec<_> = retrieve(&root, "What is retry_limit?", &[], &AtomicBool::new(false))
            .unwrap()
            .passages
            .into_iter()
            .map(|passage| passage.source.relative_path)
            .collect();
        assert_eq!(paths, ["z_def.rs", "a_use.rs"]);
    }

    #[test]
    fn falls_back_to_file_heads_only_when_no_text_matches() {
        let fixture = TempDir::new().unwrap();
        let dir = fixture.path();
        fs::write(dir.join("print.py"), "print(\"Hello\")\n").unwrap();
        fs::write(dir.join("print.cpp"), "int main() {}\n").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("workbench", dir).unwrap();
        let root = registry.ask_root("workbench", &workspace.id).unwrap();
        let cancelled = AtomicBool::new(false);
        for question in ["What do these files do?", "what does this do"] {
            let paths: Vec<_> = retrieve(&root, question, &[], &cancelled)
                .unwrap()
                .passages
                .into_iter()
                .map(|passage| passage.source.relative_path)
                .collect();
            assert_eq!(paths, ["print.cpp", "print.py"], "{question}");
        }
        let matched = retrieve(&root, "Where is main?", &[], &cancelled).unwrap();
        assert_eq!(matched.passages.len(), 1);
        assert_eq!(matched.passages[0].source.relative_path, "print.cpp");
    }

    #[test]
    fn server_symbols_rank_c_style_definitions_and_ignore_unmatched_paths() {
        let fixture = TempDir::new().unwrap();
        let dir = fixture.path();
        fs::write(dir.join("a_use.c"), "int total = helper(1);\n").unwrap();
        let mut definition = "// filler\n".repeat(PASSAGE_LINES);
        definition.push_str("int helper(int value)\n{\n    return value;\n}\n");
        fs::write(dir.join("z_def.c"), definition).unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("workbench", dir).unwrap();
        let root = registry.ask_root("workbench", &workspace.id).unwrap();
        let cancelled = AtomicBool::new(false);
        let ranked = |symbols: &[AskSymbol]| {
            retrieve(&root, "What does helper do?", symbols, &cancelled)
                .unwrap()
                .passages
                .into_iter()
                .map(|passage| (passage.source.relative_path, passage.source.start_line))
                .collect::<Vec<_>>()
        };
        let symbol = |path: &str, line: usize, name: &str| AskSymbol {
            path: path.into(),
            line,
            name: name.into(),
        };
        // The text ranking treats the C-style declaration as a mention.
        let regex = ranked(&[]);
        assert_eq!(regex, [("a_use.c".into(), 1), ("z_def.c".into(), 13)]);
        // Symbols that match no scanned path, name, or block text change nothing.
        let unrelated = [
            symbol("../outside.c", PASSAGE_LINES, "helper"),
            symbol("missing.c", 0, "helper"),
            symbol("z_def.c", PASSAGE_LINES, "other"),
            symbol("z_def.c", 0, "helper"),
        ];
        assert_eq!(ranked(&unrelated), regex);
        assert_eq!(
            ranked(&[symbol("z_def.c", PASSAGE_LINES, "Helper")]),
            [("z_def.c".into(), 13), ("a_use.c".into(), 1)]
        );
        // Regex and server definitions of the same term are counted once.
        fs::write(dir.join("y_def.rs"), "fn helper() {}\n").unwrap();
        let both = retrieve(
            &root,
            "helper",
            &[symbol("y_def.rs", 0, "helper")],
            &cancelled,
        )
        .unwrap();
        assert_eq!(both.passages[0].source.relative_path, "y_def.rs");
        assert_eq!(both.passages[0].score, 5);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_and_denies_replaced_root() {
        use std::os::unix::fs::symlink;

        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("project");
        fs::create_dir(&root).unwrap();
        let outside = fixture.path().join("outside.rs");
        fs::write(&outside, "MAX_TABS").unwrap();
        symlink(outside, root.join("linked.rs")).unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("workbench", &root).unwrap();
        let handle = registry.ask_root("workbench", &workspace.id).unwrap();
        let result = retrieve(&handle, "MAX_TABS", &[], &AtomicBool::new(false)).unwrap();
        assert!(result.passages.is_empty());
        fs::rename(&root, fixture.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(registry.ask_root("workbench", &workspace.id).is_err());
    }
}
