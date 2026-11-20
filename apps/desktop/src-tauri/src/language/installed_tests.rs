use super::*;
use std::{fs, thread};

fn wait(session: &mut Session, registry: &Registry, found: impl Fn(&Update) -> bool) -> Update {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let update = session.poll(registry, "owner").unwrap();
        if found(&update) {
            return update;
        }
        assert!(Instant::now() < deadline, "{:?} timed out", session.kind);
        thread::sleep(Duration::from_millis(20));
    }
}

fn project(
    kind: Kind,
    variable: &str,
    config: (&str, &str),
    first: (&str, &str),
    second: (&str, &str),
    position: Position,
) {
    let executable = PathBuf::from(std::env::var_os(variable).expect(variable));
    let executable = Executable::new(&executable, kind).unwrap();
    let directory = tempfile::tempdir().unwrap();
    Process::probe(&executable, directory.path(), kind).unwrap();
    for (path, text) in [config, first, second] {
        let path = directory.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let mut registry = Registry::default();
    let workspace = registry.register("owner", directory.path()).unwrap();
    let root = registry.language_root("owner", &workspace.id).unwrap();
    let mut session = Session::launch(workspace.id, &executable, kind, root, false).unwrap();
    let capabilities = wait(&mut session, &registry, |update| {
        update.capabilities.is_some()
    })
    .capabilities
    .unwrap();
    for ((path, text), version) in [(first, 1), (second, 2)] {
        session
            .apply(
                &registry,
                "owner",
                Action::Sync {
                    path: path.into(),
                    text: text.into(),
                    version,
                    saved: false,
                },
            )
            .unwrap();
    }
    let features = [
        (Feature::Hover, None),
        (Feature::Definition, None),
        (Feature::References, None),
        (Feature::Rename, Some("renamed".into())),
        (Feature::WorkspaceSymbol, Some("answer".into())),
    ];
    // Rust's project loading continues asynchronously after initialize.
    for (index, (feature, new_name)) in features.into_iter().enumerate() {
        assert!(capabilities.supports(feature));
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut attempt = 0;
        loop {
            let request_id = 3 + index as u32 * 1000 + attempt;
            let (anchor, version, cursor) =
                if kind == Kind::Typescript && matches!(feature, Feature::Rename) {
                    // At the import, TypeScript renames the local alias. Start
                    // at the export to verify a project-wide declaration rename.
                    (
                        first.0,
                        1,
                        Position {
                            line: 0,
                            character: 17,
                        },
                    )
                } else {
                    (second.0, 2, position)
                };
            session
                .apply(
                    &registry,
                    "owner",
                    Action::Request {
                        path: anchor.into(),
                        version,
                        position: cursor,
                        feature,
                        new_name: new_name.clone(),
                        request_id,
                    },
                )
                .unwrap();
            let reply = wait(&mut session, &registry, |update| {
                update.events.iter().any(|event| matches!(event, Event::Response { request_id: id, .. } if *id == request_id))
            });
            let result = reply
                .events
                .into_iter()
                .find_map(|event| match event {
                    Event::Response {
                        request_id: id,
                        value,
                    } if id == request_id => Some(value),
                    _ => None,
                })
                .unwrap();
            let valid = match feature {
                Feature::Hover => result.get("contents").is_some(),
                Feature::Definition => result.pointer("/0/path") == Some(&json!(first.0)),
                Feature::References => result.as_array().is_some_and(|items| {
                    [first.0, second.0]
                        .iter()
                        .all(|path| items.iter().any(|item| item["path"] == *path))
                }),
                Feature::Rename => result["files"].as_array().is_some_and(|items| {
                    [first.0, second.0]
                        .iter()
                        .all(|path| items.iter().any(|item| item["path"] == *path))
                }),
                Feature::WorkspaceSymbol => result.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["path"] == first.0 && item["name"] == "answer")
                }),
                _ => unreachable!(),
            };
            if valid {
                break;
            }
            assert!(
                Instant::now() < deadline && attempt < 999,
                "{kind:?} {}: {result}",
                feature.method()
            );
            attempt += 1;
            thread::sleep(Duration::from_millis(150));
        }
    }
    session
        .apply(
            &registry,
            "owner",
            Action::Sync {
                path: second.0.into(),
                text: format!(
                    "{}\n{}",
                    second.1,
                    match kind {
                        Kind::Typescript => "const bad: number = 'text';",
                        Kind::Pyright => "bad: int = 'text'",
                        Kind::RustAnalyzer => "fn invalid( {",
                        Kind::Clangd => "int invalid = missing;",
                    }
                ),
                version: 3,
                saved: false,
            },
        )
        .unwrap();
    wait(&mut session, &registry, |update| {
        update.events.iter().any(|event|
        matches!(event, Event::Diagnostics {version: 3, diagnostics, ..} if !diagnostics.is_empty())
    )
    });
    process::assert_real_server_stopped(session.process.shutdown());
}

#[test]
#[ignore = "requires TURING_TEST_TSLS"]
fn installed_typescript() {
    project(
        Kind::Typescript,
        "TURING_TEST_TSLS",
        ("tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}"),
        ("helper.ts", "export function answer() { return 42; }\n"),
        ("main.ts", "import { answer } from './helper';\nanswer();\n"),
        Position {
            line: 1,
            character: 2,
        },
    );
}

#[test]
#[ignore = "requires TURING_TEST_PYRIGHT"]
fn installed_pyright() {
    project(
        Kind::Pyright,
        "TURING_TEST_PYRIGHT",
        ("pyrightconfig.json", "{}"),
        ("helper.py", "def answer() -> int:\n    return 42\n"),
        ("main.py", "from helper import answer\nanswer()\n"),
        Position {
            line: 1,
            character: 2,
        },
    );
}

#[test]
#[ignore = "requires TURING_TEST_RUST_ANALYZER"]
fn installed_rust_analyzer() {
    project(
        Kind::RustAnalyzer,
        "TURING_TEST_RUST_ANALYZER",
        (
            "Cargo.toml",
            "[package]\nname = 'fixture'\nversion = '0.1.0'\nedition = '2021'\n",
        ),
        ("src/helper.rs", "pub fn answer() -> i32 { 42 }\n"),
        (
            "src/main.rs",
            "mod helper;\nfn main() { helper::answer(); }\n",
        ),
        Position {
            line: 1,
            character: 22,
        },
    );
}

#[test]
#[ignore = "requires TURING_TEST_CLANGD"]
fn installed_clangd_project_features() {
    project(
        Kind::Clangd,
        "TURING_TEST_CLANGD",
        ("README.md", ""),
        ("helper.hpp", "inline int answer() { return 42; }\n"),
        (
            "main.cpp",
            "#include \"helper.hpp\"\nint main() { return answer(); }\n",
        ),
        Position {
            line: 1,
            character: 21,
        },
    );
}
