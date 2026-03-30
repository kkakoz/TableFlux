package chat

import (
	"regexp"
	"strings"
)

// 常见会与未加反引号标识符冲突的 MySQL 保留字（表名场景）
var mysqlReservedTableNames = map[string]struct{}{
	"order": {}, "group": {}, "select": {}, "table": {}, "key": {}, "user": {},
	"status": {}, "rank": {}, "rows": {}, "desc": {}, "partition": {},
	"references": {}, "read": {}, "write": {}, "signal": {}, "sql": {},
}

func isMysqlReservedTableName(name string) bool {
	_, ok := mysqlReservedTableNames[strings.ToLower(strings.TrimSpace(name))]
	return ok
}

// sanitizeMySQLIdentifierSQL 在模型漏写反引号时，为保留字表名补全反引号，减轻 1064 语法错误。
func sanitizeMySQLIdentifierSQL(sql string, relevantTables []string) string {
	if strings.TrimSpace(sql) == "" {
		return sql
	}
	out := sql
	for _, raw := range relevantTables {
		t := strings.TrimSpace(raw)
		if t == "" || !isMysqlReservedTableName(t) {
			continue
		}
		quoted := "`" + t + "`"
		if strings.Contains(out, quoted) {
			continue
		}
		// FROM order / JOIN order / INTO order / UPDATE order / TABLE order
		kw := regexp.MustCompile(`(?i)\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+` + regexp.QuoteMeta(t) + `\b`)
		out = kw.ReplaceAllStringFunc(out, func(m string) string {
			sub := kw.FindStringSubmatch(m)
			if len(sub) < 3 {
				return m
			}
			return sub[1] + " `" + sub[2] + "`"
		})
		// FROM a, order（逗号分隔表名）
		comma := regexp.MustCompile(`(?i)(,\s*)` + regexp.QuoteMeta(t) + `\b`)
		out = comma.ReplaceAllStringFunc(out, func(m string) string {
			sub := comma.FindStringSubmatch(m)
			if len(sub) < 3 {
				return m
			}
			return sub[1] + "`" + sub[2] + "`"
		})
	}
	return out
}
