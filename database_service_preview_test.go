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
