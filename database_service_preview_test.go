package main

import "testing"

func TestSQLStringLiteralForPreview(t *testing.T) {
	t.Parallel()
	pg := sqlStringLiteralForPreview("postgres", `a'b`)
	if pg != `'a''b'` {
		t.Fatalf("postgres quote: got %q", pg)
	}
	my := sqlStringLiteralForPreview("mysql", `a'b\c`)
	if my != `'a''b\\c'` {
		t.Fatalf("mysql quote: got %q", my)
	}
}

func TestFormatSQLLiteralForPreview(t *testing.T) {
	t.Parallel()
	if formatSQLLiteralForPreview("postgres", nil) != "NULL" {
		t.Fatal("NULL")
	}
	if formatSQLLiteralForPreview("postgres", true) != "TRUE" {
		t.Fatal("bool pg")
	}
	if formatSQLLiteralForPreview("mysql", false) != "0" {
		t.Fatal("bool mysql")
	}
	if formatSQLLiteralForPreview("postgres", 42) != "42" {
		t.Fatal("int")
	}
	if got := formatSQLLiteralForPreview("mysql", float64(2386207)); got != "2386207" {
		t.Fatalf("float id should not be scientific notation: %s", got)
	}
	if got := formatSQLLiteralForPreview("mysql", "2026-03-29T01:07:57Z"); got != "'2026-03-29 01:07:57'" {
		t.Fatalf("rfc3339 mysql time = %s", got)
	}
	if got := formatSQLLiteralForPreview("postgres", "2026-03-29T01:07:57.123456Z"); got != "'2026-03-29 01:07:57.123456'" {
		t.Fatalf("rfc3339 postgres time = %s", got)
	}
	if got := formatSQLLiteralForPreview("mysql", "not-a-timeTvalue"); got != "'not-a-timeTvalue'" {
		t.Fatalf("non-time string = %s", got)
	}
}

func TestBuildUpdateStatementPreview(t *testing.T) {
	t.Parallel()
	row := map[string]any{
		"id":   1,
		"name": "O'Reilly",
	}
	sql := buildUpdateStatementPreview("mysql", "", "t", []string{"id"}, row, []string{"name"})
	if sql != "UPDATE `t` SET `name`='O''Reilly' WHERE `id`=1" {
		t.Fatalf("got: %s", sql)
	}
}
