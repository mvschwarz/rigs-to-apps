<?php
// Token bootstrap (the low-code path proven in the Phase-2 first act): read
// Kanboard's auto-generated application api_token directly from the SQLite
// settings table. One query, deterministic, no UI login / CSRF / HTML scrape.
// Printed to stdout ONLY; the caller redirects to a 0600 env-file. The value is
// NEVER surfaced to a transcript, log, or commit.
$db = new PDO("sqlite:/var/www/app/data/db.sqlite");
echo $db->query("SELECT value FROM settings WHERE option='api_token'")->fetchColumn();
