//! Test-only checks that native IPC serialization matches the shared
//! contract fixtures in `packages/contracts/fixtures/ipc-contract.json`.
//! The TypeScript suite checks the same fixtures against the declared
//! contracts, so drift on either side fails a test.

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

const FIXTURE: &str = include_str!("../../../../packages/contracts/fixtures/ipc-contract.json");

fn fixture() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(FIXTURE).expect("contract fixture is valid JSON"))
}

pub(crate) fn at(pointer: &str) -> &'static Value {
    fixture()
        .pointer(pointer)
        .unwrap_or_else(|| panic!("contract fixture has no entry at {pointer}"))
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("contract value serializes")
}

fn sorted_strings(values: Vec<Value>) -> Vec<String> {
    let mut strings: Vec<String> = values
        .into_iter()
        .map(|value| match value {
            Value::String(text) => text,
            other => panic!("expected a string code, got {other}"),
        })
        .collect();
    strings.sort();
    strings
}

fn assert_codes<T: Serialize>(values: &[T], pointer: &str) {
    let native = sorted_strings(values.iter().map(to_value).collect());
    let expected = sorted_strings(
        at(pointer)
            .as_array()
            .unwrap_or_else(|| panic!("{pointer} is not an array"))
            .clone(),
    );
    assert_eq!(
        native, expected,
        "codes drifted from contract fixture at {pointer}"
    );
}

/// Every native error code for `domain` must appear in the fixture's
/// `native` list, and every fixture code must be produced natively.
pub fn assert_error_codes<T: Serialize>(domain: &str, values: &[T]) {
    assert_codes(values, &format!("/errors/{domain}/native"));
}

/// Serialized enum values must exactly match the fixture's value list.
pub fn assert_enum_values<T: Serialize>(name: &str, values: &[T]) {
    assert_codes(values, &format!("/enums/{name}"));
}

/// The serialized value must equal fixture case `index` of `payload`
/// exactly, including field names, casing, nulls and omitted fields.
pub fn assert_payload<T: Serialize>(payload: &str, index: usize, value: &T) {
    assert_eq!(
        &to_value(value),
        at(&format!("/payloads/{payload}/{index}")),
        "{payload} case {index} drifted from contract fixture"
    );
}

/// Each fixture case must be covered by a native test, so a new case
/// cannot be added on the TypeScript side alone.
pub fn assert_case_count(payload: &str, covered: usize) {
    let cases = at(&format!("/payloads/{payload}"))
        .as_array()
        .map_or(0, Vec::len);
    assert_eq!(
        cases, covered,
        "{payload}: native tests cover {covered} of {cases} fixture cases"
    );
}
