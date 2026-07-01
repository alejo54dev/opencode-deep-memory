import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

const HOME = process.env.HOME || "/tmp";
const STORAGE_DIR = `${HOME}/.config/opencode/storage`;
const DB_PATH = `${STORAGE_DIR}/hello.db`;
const LOG_PATH = `${STORAGE_DIR}/sqlite-test.log`;

function log(m: string)
{
	try
	{
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${m}\n`);
	}
	catch {}
}

export default async function sqliteTest()
{
	log("START");

	if (!existsSync(STORAGE_DIR))
		mkdirSync(STORAGE_DIR, { recursive: true });

	try
	{
		const db = new Database(DB_PATH);
		db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("INSERT INTO t(v) VALUES(?)", ["ok"]);
		const r = db.query("SELECT v FROM t WHERE id=1").get() as { v: string };
		log(`SUCCESS: ${r.v}`);
		db.close();
	}
	catch (e)
	{
		log(`FAIL: ${(e as Error).message}`);
	}

	return {};
}
