export type ConnectionFormValues = {
  name: string;
  driver: "mysql" | "postgres";
  host: string;
  port: number;
  user: string;
  password: string;
  defaultDb: string;
  sslMode: string;
  charset: string;
  connectTimeoutSec: number;
  /** 环境标签，写入 tags：env:dev / env:test */
  env: "" | "dev" | "test";
};

export const defaultConnectionForm = (): ConnectionFormValues => ({
  name: "",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  defaultDb: "",
  sslMode: "disable",
  charset: "",
  connectTimeoutSec: 30,
  env: "",
});

export function tagsFromForm(baseTags: string[], v: ConnectionFormValues): string[] {
  const rest = baseTags.filter((t) => !t.startsWith("env:") && !t.startsWith("charset:"));
  const next = [...rest];
  if (v.env) next.push(`env:${v.env}`);
  if (v.charset.trim()) next.push(`charset:${v.charset.trim()}`);
  return next;
}

export function parseMetaToForm(c: {
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  defaultDb: string;
  sslMode: string;
  tags: string[];
}): ConnectionFormValues {
  let env: ConnectionFormValues["env"] = "";
  let charset = "";
  for (const t of c.tags) {
    if (t.startsWith("env:")) {
      const v = t.slice(4);
      if (v === "dev" || v === "test") env = v;
    }
    if (t.startsWith("charset:")) charset = t.slice(8);
  }
  return {
    name: c.name,
    driver: c.driver === "postgres" ? "postgres" : "mysql",
    host: c.host,
    port: c.port,
    user: c.user,
    password: "",
    defaultDb: c.defaultDb,
    sslMode: c.sslMode || "disable",
    charset,
    connectTimeoutSec: 30,
    env,
  };
}
