package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestClampMigrationWorkerCount(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{name: "default for zero", in: 0, want: 2},
		{name: "default for negative", in: -3, want: 2},
		{name: "keeps valid", in: 4, want: 4},
		{name: "caps max", in: 99, want: 8},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := clampMigrationWorkerCount(tt.in); got != tt.want {
				t.Fatalf("clampMigrationWorkerCount(%d) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestNormalizeMigrationBatchSize(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{name: "defaults zero", in: 0, want: 500},
		{name: "accepts 200", in: 200, want: 200},
		{name: "accepts 500", in: 500, want: 500},
		{name: "accepts 1000", in: 1000, want: 1000},
		{name: "rejects other values", in: 300, want: 500},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeMigrationBatchSize(tt.in); got != tt.want {
				t.Fatalf("normalizeMigrationBatchSize(%d) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestMigrationBatchSizeCapsPostgresParameterCount(t *testing.T) {
	if got := migrationBatchSize("postgres", 100, 1000); got != 600 {
		t.Fatalf("migrationBatchSize(postgres, 100, 1000) = %d, want 600", got)
	}
	if got := migrationBatchSize("mysql", 100, 1000); got != 1000 {
		t.Fatalf("migrationBatchSize(mysql, 100, 1000) = %d, want 1000", got)
	}
}

func TestStartDataMigrationRejectsEmptyTableListBeforeConnections(t *testing.T) {
	s := &DatabaseService{migrationJobs: map[string]*dataMigrationJob{}}
	if _, err := s.StartDataMigration(DataMigrationBatchRequest{
		SourceConnectionID: "src",
		SourceDatabase:     "db1",
		TargetConnectionID: "dst",
		TargetDatabase:     "db2",
		SourceTables:       []string{"", "   "},
	}); err == nil {
		t.Fatal("expected empty sourceTables error")
	}
}

func TestMigrationBatchSizeRespectsPostgresParameterLimit(t *testing.T) {
	if got := migrationBatchSize("postgres", 200, 500); got != 300 {
		t.Fatalf("migrationBatchSize(postgres, 200, 500) = %d, want 300", got)
	}
	if got := migrationBatchSize("mysql", 200, 500); got != 500 {
		t.Fatalf("migrationBatchSize(mysql, 200, 500) = %d, want 500", got)
	}
}

func TestBuildMigrationCreateTableSQL(t *testing.T) {
	schema := TableSchema{
		Columns: []TableColumnSchema{
			{Name: "id", Type: "int", PrimaryKey: true, AutoIncrement: true},
			{Name: "name", Type: "varchar(64)", Nullable: false},
			{Name: "payload", Type: "json", Nullable: true},
		},
		PrimaryKey: []string{"id"},
	}

	mysql := buildMigrationCreateTableSQL("mysql", "", "users", schema)
	wantMySQL := "CREATE TABLE `users` (`id` INT AUTO_INCREMENT NOT NULL,`name` VARCHAR(64) NOT NULL,`payload` JSON,PRIMARY KEY (`id`))"
	if mysql != wantMySQL {
		t.Fatalf("mysql ddl = %q, want %q", mysql, wantMySQL)
	}

	postgres := buildMigrationCreateTableSQL("postgres", "public", "users", schema)
	wantPostgres := `CREATE TABLE "public"."users" ("id" SERIAL NOT NULL,"name" VARCHAR(64) NOT NULL,"payload" JSONB,PRIMARY KEY ("id"))`
	if postgres != wantPostgres {
		t.Fatalf("postgres ddl = %q, want %q", postgres, wantPostgres)
	}
}

func TestTableSchemaColumnNamesUsesRawColumnNames(t *testing.T) {
	got := tableSchemaColumnNames([]TableColumnSchema{
		{Name: "id"},
		{Name: "name"},
		{Name: "   "},
	})
	want := []string{"id", "name"}
	if len(got) != len(want) {
		t.Fatalf("tableSchemaColumnNames length = %d, want %d: %#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tableSchemaColumnNames[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestRunDataMigrationJobContinuesAfterTableFailure(t *testing.T) {
	s := &DatabaseService{migrationJobs: map[string]*dataMigrationJob{}}

	var mu sync.Mutex
	seen := map[string]int{}
	s.migrationRunner = func(_ context.Context, req DataMigrationRequest) (DataMigrationResult, error) {
		mu.Lock()
		seen[req.SourceTable]++
		mu.Unlock()
		if req.SourceTable == "bad_table" {
			return DataMigrationResult{}, errors.New("target table missing")
		}
		return DataMigrationResult{MigratedRows: 3, Message: "ok"}, nil
	}

	job := &dataMigrationJob{
		id:          "job-1",
		status:      "running",
		workerCount: 2,
		startedAt:   time.Now(),
		req: DataMigrationBatchRequest{
			SourceConnectionID: "src",
			SourceDatabase:     "db1",
			SourceTables:       []string{"table_a", "bad_table", "table_b"},
			TargetConnectionID: "dst",
			TargetDatabase:     "db2",
		},
		tables: []DataMigrationTableStatus{
			{Table: "table_a", TargetTable: "table_a", Status: "pending"},
			{Table: "bad_table", TargetTable: "bad_table", Status: "pending"},
			{Table: "table_b", TargetTable: "table_b", Status: "pending"},
		},
	}
	s.migrationJobs[job.id] = job

	s.runDataMigrationJob(context.Background(), job.id)
	snapshot, err := s.GetDataMigrationJob(job.id)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Status != "failed" {
		t.Fatalf("job status = %q, want failed", snapshot.Status)
	}
	if snapshot.Success != 2 || snapshot.Failed != 1 || snapshot.Running != 0 || snapshot.Pending != 0 {
		t.Fatalf("unexpected snapshot counts: %+v", snapshot)
	}
	for _, table := range []string{"table_a", "bad_table", "table_b"} {
		if seen[table] != 1 {
			t.Fatalf("%s was processed %d times, want once", table, seen[table])
		}
	}
}
