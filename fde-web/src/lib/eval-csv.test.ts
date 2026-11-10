import { describe, expect, it } from "vitest"
import { MAX_ROWS, parseCsv, problemText, readCases, readResults } from "./eval-csv"

const suite = {
  criteria: ["crt_a", "crt_b"],
  cases: [
    { id: "one", input: "i" },
    { id: "two", input: "i" },
    { id: "three", input: "i" },
  ],
}

describe("parseCsv", () => {
  it("reads quoted values, doubled quotes, commas, newlines in values and any line ending", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n"line\none",2\r3,4')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["line\none", "2"],
      ["3", "4"],
    ])
  })

  it("skips empty lines and a byte order mark, and keeps an empty quoted value", () => {
    expect(parseCsv("﻿a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv('a\n""\n')).toEqual([["a"], [""]])
  })

  it("refuses a file that ends inside a quote", () => {
    expect(parseCsv('a,b\n1,"never closed')).toBeNull()
  })
})

describe("a file of cases", () => {
  it("is read: its rows and columns, with nothing wrong", () => {
    const r = readCases("input,expected\nwhat is 2+2,4\nname a colour,blue\n", suite)
    expect(r).toEqual({ rows: 2, columns: ["input", "expected"], problems: [] })
  })

  it("takes the header in any case, trimmed, as the API does", () => {
    expect(readCases(" Input , EXPECTED \na,b\n", suite).problems).toEqual([])
  })

  it("names an unknown column and a missing one", () => {
    expect(readCases("input,mood\na,b\n", suite).problems.map(problemText)).toEqual([
      "Unknown column “mood”. This file takes: id, input, expected, criteria.",
    ])
    expect(readCases("expected\nb\n", suite).problems.map(problemText)).toEqual([
      "The file needs a column called input.",
    ])
  })

  it("names the row with a bad id, a taken id, or a criterion the suite does not measure", () => {
    const r = readCases(
      [
        "id,input,criteria",
        "ok-1,a,crt_a",
        "bad id,b,",
        "one,c,",
        "ok-1,d,",
        "fresh,e,crt_other;crt_a",
      ].join("\n"),
      suite,
    )
    expect(r.problems.map(problemText)).toEqual([
      "Row 2 has an id that is not letters, digits, _ or -, up to 128 long.",
      "Row 3 uses the id “one”, which is already a case of this suite or of this file.",
      "Row 4 uses the id “ok-1”, which is already a case of this suite or of this file.",
      "Row 5 names “crt_other”, which this suite does not measure.",
    ])
  })

  it("names a row with the wrong number of values", () => {
    expect(readCases("input,expected\na\nb,c,d\n", suite).problems.map(problemText)).toEqual([
      "Row 1 has 1 values, and the header names 2 columns.",
      "Row 2 has 3 values, and the header names 2 columns.",
    ])
  })

  it("refuses a value over 64 KB or with a null character, and too many rows", () => {
    const big = "x".repeat(64 * 1024 + 1)
    expect(readCases(`input\n${big}\n`, suite).problems.map(problemText)).toEqual([
      "Row 1 has an input over 64 KB, or with a null character.",
    ])
    expect(
      readCases(`input\n${"a\n".repeat(MAX_ROWS + 1)}`, suite).problems.map(problemText),
    ).toEqual(["The file has more than 10,000 rows."])
  })

  it("says an empty file, and a file that never closes a quote", () => {
    expect(readCases("", suite).problems.map(problemText)).toEqual([
      "The file is empty. The first row names the columns.",
    ])
    expect(readCases('input\n"open', suite).problems.map(problemText)).toEqual([
      "The file ends inside a quoted value.",
    ])
  })
})

describe("a file of results", () => {
  it("is read, and says how many of the suite's cases it leaves without an output", () => {
    const r = readResults("case,output\none,a\ntwo,b\n", suite)
    expect(r).toEqual({ rows: 2, columns: ["case", "output"], problems: [], without: 1 })
  })

  it("names a case twice, a case the suite does not have, and a case that is not an id", () => {
    const r = readResults(["case,output", "one,a", "one,b", "nine,c", "no way,d"].join("\n"), suite)
    expect(r.problems.map(problemText)).toEqual([
      "Row 2 lists the case “one” twice.",
      "Row 3 names “nine”, which is not a case of this suite.",
      "Row 4 has a case that is not an id (letters, digits, _ or -).",
    ])
  })

  it("needs both columns and refuses another", () => {
    expect(readResults("case\none\n", suite).problems.map(problemText)).toEqual([
      "The file needs a column called output.",
    ])
    expect(readResults("case,output,extra\none,a,b\n", suite).problems.map(problemText)).toEqual([
      "Unknown column “extra”. This file takes: case, output.",
    ])
  })
})
