CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, sender TEXT, receiver TEXT, subject TEXT, text_content TEXT, html_content TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, password TEXT NOT NULL, telegram_id TEXT, messenger_apikey TEXT, zalo_id TEXT);

