//! CSV imports (RFC 4180, with a header row): cases into a suite, and results (outputs to grade) into a run.
//!
//! Cases: `input` (required), `expected`, `id` (generated when absent or empty) and `criteria` (criterion ids
//! separated by `;`). Results: `case` and `output`. Other columns are refused, so a typo is not silently dropped.

use std::collections::HashMap;

use oryxa_fde_core::CriterionId;

use crate::ids::CaseId;
use crate::suite::{Case, MAX_CASES, MAX_TEXT_BYTES};

/// Largest CSV body accepted.
pub const MAX_CSV_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImportError {
    #[error("the CSV is larger than {MAX_CSV_BYTES} bytes")]
    TooLarge,
    #[error("the CSV has more than {MAX_CASES} rows")]
    TooManyRows,
    #[error("the CSV is malformed at row {0}")]
    Malformed(usize),
    #[error("unknown column {0}")]
    UnknownColumn(String),
    #[error("missing column {0}")]
    MissingColumn(&'static str),
    #[error("row {row}: invalid {what}")]
    Invalid { row: usize, what: &'static str },
}

fn rows(
    csv: &[u8],
    known: &[&str],
    required: &[&'static str],
) -> Result<(Vec<String>, Vec<csv::StringRecord>), ImportError> {
    if csv.len() > MAX_CSV_BYTES {
        return Err(ImportError::TooLarge);
    }
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .from_reader(csv);
    let headers: Vec<String> = reader
        .headers()
        .map_err(|_| ImportError::Malformed(0))?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    if let Some(unknown) = headers.iter().find(|h| !known.contains(&h.as_str())) {
        return Err(ImportError::UnknownColumn(unknown.chars().take(64).collect()));
    }
    for column in required {
        if !headers.iter().any(|h| h == column) {
            return Err(ImportError::MissingColumn(column));
        }
    }
    let mut records = Vec::new();
    for (i, record) in reader.records().enumerate() {
        if records.len() == MAX_CASES {
            return Err(ImportError::TooManyRows);
        }
        records.push(record.map_err(|_| ImportError::Malformed(i + 1))?);
    }
    Ok((headers, records))
}

fn field<'a>(headers: &[String], record: &'a csv::StringRecord, name: &str) -> Option<&'a str> {
    headers.iter().position(|h| h == name).and_then(|i| record.get(i))
}

fn text(value: &str, row: usize, what: &'static str) -> Result<String, ImportError> {
    if value.len() > MAX_TEXT_BYTES || value.contains('\0') {
        Err(ImportError::Invalid { row, what })
    } else {
        Ok(value.to_owned())
    }
}

/// Cases from CSV. `new_id` names a case whose `id` column is absent or empty.
pub fn cases(csv: &[u8], mut new_id: impl FnMut() -> String) -> Result<Vec<Case>, ImportError> {
    let (headers, records) = rows(csv, &["id", "input", "expected", "criteria"], &["input"])?;
    records
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let row = i + 1;
            let id = match field(&headers, r, "id").map(str::trim).filter(|s| !s.is_empty()) {
                Some(id) => id.to_owned(),
                None => new_id(),
            };
            let criteria = field(&headers, r, "criteria")
                .unwrap_or("")
                .split(';')
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(|c| CriterionId::new(c).map_err(|_| ImportError::Invalid { row, what: "criteria" }))
                .collect::<Result<_, _>>()?;
            Ok(Case {
                id: CaseId::new(id).map_err(|_| ImportError::Invalid { row, what: "id" })?,
                input: text(field(&headers, r, "input").unwrap_or(""), row, "input")?,
                expected: field(&headers, r, "expected")
                    .filter(|e| !e.is_empty())
                    .map(|e| text(e, row, "expected"))
                    .transpose()?,
                criteria,
            })
        })
        .collect()
}

/// Outputs to grade, by case, from CSV. A case listed twice is refused.
pub fn results(csv: &[u8]) -> Result<HashMap<CaseId, String>, ImportError> {
    let (headers, records) = rows(csv, &["case", "output"], &["case", "output"])?;
    let mut outputs = HashMap::new();
    for (i, r) in records.iter().enumerate() {
        let row = i + 1;
        let case = CaseId::new(field(&headers, r, "case").unwrap_or("").trim())
            .map_err(|_| ImportError::Invalid { row, what: "case" })?;
        let output = text(field(&headers, r, "output").unwrap_or(""), row, "output")?;
        if outputs.insert(case, output).is_some() {
            return Err(ImportError::Invalid {
                row,
                what: "case (listed twice)",
            });
        }
    }
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("case_{n}")
        }
    }

    #[test]
    fn reads_cases_with_quotes_newlines_and_optional_columns() {
        let csv = b"input,expected,criteria,id\n\"Is it up?\",yes,crit_a; crit_b,c1\n\"Multi\nline, with \"\"quotes\"\"\",,,\n";
        let cases = cases(csv, ids()).unwrap();
        assert_eq!(cases.len(), 2);
        assert_eq!(cases[0].id.as_str(), "c1");
        assert_eq!(cases[0].expected.as_deref(), Some("yes"));
        assert_eq!(
            cases[0].criteria,
            [CriterionId::new("crit_a").unwrap(), CriterionId::new("crit_b").unwrap()]
        );
        assert_eq!(cases[1].id.as_str(), "case_1");
        assert_eq!(cases[1].input, "Multi\nline, with \"quotes\"");
        assert_eq!(cases[1].expected, None);
    }

    #[test]
    fn refuses_what_it_cannot_read_exactly() {
        assert_eq!(
            cases(b"input,score\nx,1\n", ids()),
            Err(ImportError::UnknownColumn("score".into()))
        );
        assert_eq!(cases(b"expected\nx\n", ids()), Err(ImportError::MissingColumn("input")));
        assert_eq!(cases(b"input,expected\nx\n", ids()), Err(ImportError::Malformed(1)));
        assert_eq!(
            cases(b"input,id\nx,bad id\n", ids()),
            Err(ImportError::Invalid { row: 1, what: "id" })
        );
        assert_eq!(
            cases(b"input,criteria\nx,crit|1\n", ids()),
            Err(ImportError::Invalid {
                row: 1,
                what: "criteria"
            })
        );
        let big = format!("input\n{}\n", "x".repeat(MAX_TEXT_BYTES + 1));
        assert_eq!(
            cases(big.as_bytes(), ids()),
            Err(ImportError::Invalid { row: 1, what: "input" })
        );
        let many = format!("input\n{}", "x\n".repeat(MAX_CASES + 1));
        assert_eq!(cases(many.as_bytes(), ids()), Err(ImportError::TooManyRows));
        assert_eq!(cases(&vec![b'x'; MAX_CSV_BYTES + 1], ids()), Err(ImportError::TooLarge));
    }

    #[test]
    fn reads_results_by_case() {
        let out = results(b"case,output\nc1,\"{\"\"up\"\": true}\"\nc2,down\n").unwrap();
        assert_eq!(out[&CaseId::new("c1").unwrap()], "{\"up\": true}");
        assert_eq!(out.len(), 2);
        assert_eq!(
            results(b"case,output\nc1,a\nc1,b\n"),
            Err(ImportError::Invalid {
                row: 2,
                what: "case (listed twice)"
            })
        );
        assert_eq!(results(b"case\nc1\n"), Err(ImportError::MissingColumn("output")));
    }
}
