// Import cÃ¡c module cáº§n thiáº¿t
require('dotenv').config(); // Load biáº¿n mÃ´i trÆ°á»ng tá»« file .env
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// Äá»‹nh nghÄ©a cá»•ng mÃ  server sáº½ láº¯ng nghe
const port = 3000;

// Táº¡o káº¿t ná»‘i Database
const dbUrl = new URL(process.env.DATABASE_URL);
const pool = mysql.createPool({
    host: dbUrl.hostname,
    user: dbUrl.username,
    password: dbUrl.password,
    database: dbUrl.pathname.slice(1), // Loại bỏ dấu '/' ở đầu tên database
    port: dbUrl.port,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false // Chấp nhận chứng chỉ SSL của Aiven
    }
});

// Helper chia mảng lớn thành từng chunk để bulk insert/update nhanh
const chunkArray = (arr, size = 1000) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
};

// Kiá»ƒm tra káº¿t ná»‘i Pool (Optional)
pool.getConnection((err, connection) => {
    if (err) console.error('âŒ Lá»—i káº¿t ná»‘i Database:', err.message);
    else { console.log('âœ… Káº¿t ná»‘i Database (Pool) sáºµn sÃ ng!'); connection.release(); }
});

// Táº¡o má»™t server HTTP
const server = http.createServer((req, res) => {
    // Láº¥y Ä‘Æ°á»ng dáº«n URL mÃ  ngÆ°á»i dÃ¹ng yÃªu cáº§u
    const baseURL = 'http://' + req.headers.host + '/';
    const reqUrl = new URL(req.url, baseURL);
    const pathname = reqUrl.pathname;

    // --- API MODEL: Xá»­ lÃ½ dá»¯ liá»‡u Releasing (Tráº£ vá» JSON) ---
    if (pathname === '/api/releasing' && req.method === 'GET') {
        const sql = 'SELECT * FROM releasing ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lá»—i truy váº¥n SQL:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return; // Káº¿t thÃºc xá»­ lÃ½
    }

    // --- API: Import Excel (Nháº­n dá»¯ liá»‡u JSON vÃ  xá»­ lÃ½ Insert/Update) ---
    if (pathname === '/api/releasing/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                if (!Array.isArray(importData) || importData.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Không có dữ liệu import' }));
                }

                const sql = `
                    INSERT INTO releasing (release_key, release_date, sku, status, release_qty, change_reason)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        release_qty = VALUES(release_qty),
                        status = VALUES(status),
                        change_reason = VALUES(change_reason)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(importData, 1000)) {
                    const values = chunk.map(item => [
                        item.release_key,
                        item.release_date,
                        item.sku,
                        item.status ?? 1,
                        item.release_qty ?? 0,
                        'Import Excel'
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    // affectedRows = inserted + 2*updated (MySQL behavior with ON DUP)
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import hoàn tất (bulk)', stats: { inserted, updated, total: importData.length } }));
            } catch (err) {
                console.error('Lỗi xử lý import:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi xử lý dữ liệu import' }));
            }
        });
        return; // Káº¿t thÃºc xá»­ lÃ½, khÃ´ng cháº¡y xuá»‘ng pháº§n Ä‘á»c file bÃªn dÆ°á»›i
    }

    // --- API MODEL: Xá»­ lÃ½ dá»¯ liá»‡u DSO ---
    if (pathname === '/api/dso' && req.method === 'GET') {
        const sql = 'SELECT * FROM dso ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lá»—i truy váº¥n SQL:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Import Excel DSO (Logic: Check Key -> Update Status / Insert New) ---
    if (pathname === '/api/dso/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                if (!Array.isArray(importData) || importData.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Không có dữ liệu import' }));
                }

                const sql = `
                    INSERT INTO dso (release_key, status_dso, child_po)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        status_dso = VALUES(status_dso),
                        child_po = VALUES(child_po)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(importData, 1000)) {
                    const values = chunk.map(item => [
                        item.release_key,
                        item.status,
                        item.huser_defined_02
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import DSO hoàn tất (bulk)', stats: { inserted, updated, total: importData.length } }));
            } catch (err) {
                console.error('Lá»—i xá»­ lÃ½ import DSO:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i xá»­ lÃ½ dá»¯ liá»‡u import' }));
            }
        });
        return;
    }

    // --- API MODEL: Xá»­ lÃ½ dá»¯ liá»‡u BBR Report ---
    if (pathname === '/api/bbr' && req.method === 'GET') {
        const sql = 'SELECT * FROM bbrreport_raw ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lá»—i truy váº¥n SQL (BBR):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Import Excel BBR Report (Logic: Check 3 keys -> Update / Insert) ---
    if (pathname === '/api/bbr/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                if (!Array.isArray(importData) || importData.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Không có dữ liệu import' }));
                }

                const sql = `
                    INSERT INTO bbrreport_raw (child_po, parent_po, sku, qty_bbr, remark)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        qty_bbr = VALUES(qty_bbr),
                        remark = VALUES(remark)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(importData, 1000)) {
                    const values = chunk.map(item => [
                        item.child_po,
                        item.parent_po,
                        item.sku,
                        item.qty_bbr ?? 0,
                        'Import Excel'
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import BBR hoàn tất (bulk)', stats: { inserted, updated, total: importData.length } }));
            } catch (err) {
                console.error('Lá»—i xá»­ lÃ½ import BBR:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i xá»­ lÃ½ dá»¯ liá»‡u import' }));
            }
        });
        return;
    }

    // --- API MODEL: Check Data (Join Releasing -> DSO -> BBR) ---
    if (pathname === '/api/check' && req.method === 'GET') {
        const sql = `
            SELECT 
                r.release_key, r.sku, r.release_qty, 
                d.child_po, 
                b.parent_po, b.qty_bbr
            FROM releasing r
            LEFT JOIN dso d ON r.release_key = d.release_key
            LEFT JOIN bbrreport_raw b ON d.child_po = b.child_po AND r.sku = b.sku
            WHERE r.status = 3
        `;
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lá»—i truy váº¥n SQL (Check):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API MODEL: Inventory ---
    if (pathname === '/api/inventory' && req.method === 'GET') {
        // JOIN voi masterdata de tinh CBM = qty_invetory * cbm
        const sql = `
            SELECT i.*, m.cbm, (IFNULL(i.qty_invetory, 0) * IFNULL(m.cbm, 0)) AS total_cbm 
            FROM inventory i
            LEFT JOIN masterdata m ON i.sku_inventory = m.sku 
            ORDER BY i.id DESC
        `;
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lá»—i truy váº¥n SQL (Inventory):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Import Inventory (XÃ³a háº¿t cÅ© -> ThÃªm má»›i) ---
    if (pathname === '/api/inventory/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                const today = new Date().toISOString().split('T')[0]; // Láº¥y ngÃ y hiá»‡n táº¡i YYYY-MM-DD

                // 1. XÃ³a toÃ n bá»™ dá»¯ liá»‡u cÅ©
                await new Promise((resolve, reject) => {
                    pool.query('DELETE FROM inventory', (err) => err ? reject(err) : resolve());
                });

                // 2. Chuáº©n bá»‹ dá»¯ liá»‡u Insert (Bulk Insert cho nhanh)
                if (importData.length > 0) {
                    const values = importData.map(item => [item.parent_po_invent, item.sku_inventory, item.qty_invetory, item.date_rcv, today]);
                    const sql = 'INSERT INTO inventory (parent_po_invent, sku_inventory, qty_invetory, date_rcv, date_update) VALUES ?';
                    await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err) => err ? reject(err) : resolve());
                    });
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Cáº­p nháº­t Inventory thÃ nh cÃ´ng', inserted: importData.length }));
            } catch (err) {
                console.error('Lá»—i Import Inventory:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i xá»­ lÃ½ dá»¯ liá»‡u import', details: err.message }));
            }
        });
        return;
    }

    // --- API MODEL: Master Data ---
    if (pathname === '/api/masterdata' && req.method === 'GET') {
        const sql = 'SELECT * FROM masterdata ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) res.writeHead(500).end(JSON.stringify(err));
            else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Import Master Data ---
    if (pathname === '/api/masterdata/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!Array.isArray(data) || data.length === 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Không có dữ liệu import' }));
                }

                const sql = `
                    INSERT INTO masterdata 
                        (MANCC, sku, description, quantity, weight, length, width, height, cbm, refix, remark, loosecase, cartonperpallet, kindpallet, chipboard)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        description = VALUES(description),
                        quantity = VALUES(quantity),
                        weight = VALUES(weight),
                        length = VALUES(length),
                        width = VALUES(width),
                        height = VALUES(height),
                        cbm = VALUES(cbm),
                        refix = VALUES(refix),
                        remark = VALUES(remark),
                        loosecase = VALUES(loosecase),
                        cartonperpallet = VALUES(cartonperpallet),
                        kindpallet = VALUES(kindpallet),
                        chipboard = VALUES(chipboard);
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(data, 1000)) {
                    const values = chunk.map(item => [
                        item.MANCC || 'NCC_DEFAULT',
                        item.sku,
                        item.description || null,
                        parseInt(item.quantity) || 0,
                        parseFloat(item.weight) || 0,
                        parseFloat(item.length) || 0,
                        parseFloat(item.width) || 0,
                        parseFloat(item.height) || 0,
                        parseFloat(item.cbm) || 0,
                        item.refix || null,
                        item.remark || null,
                        item.loosecase || null,
                        item.cartonperpallet || 0,
                        item.kindpallet || null,
                        item.chipboard || null
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Done (bulk)', stats: { inserted, updated, total: data.length } }));
            } catch (err) { res.writeHead(500).end(JSON.stringify(err)); }
        });
        return;
    }

    // --- API MODEL: DC ---
    if (pathname === '/api/dc' && req.method === 'GET') {
        const sql = 'SELECT * FROM dc';
        pool.query(sql, (err, results) => {
            if (err) res.writeHead(500).end(JSON.stringify({ error: err.message }));
            else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API MODEL: Allocate (Releasing -> DSO -> BBR -> Inventory) ---
    if (pathname === '/api/allocate' && req.method === 'GET') {
        const sql = `
            SELECT 
                r.release_key, r.release_date, r.sku, r.release_qty,
                d.child_po,
                b.parent_po,
                i.qty_invetory, i.date_rcv
            FROM releasing r
            LEFT JOIN dso d ON r.release_key = d.release_key
            LEFT JOIN bbrreport_raw b ON d.child_po = b.child_po AND r.sku = b.sku
            LEFT JOIN inventory i ON b.parent_po = i.parent_po_invent AND r.sku = i.sku_inventory
            WHERE r.status = 1
            ORDER BY r.release_key ASC, r.sku ASC, i.date_rcv ASC
        `;
        pool.query(sql, (err, results) => {
            if (err) res.writeHead(500).end(JSON.stringify({ error: err.message }));
            else res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(results));
        });
        return;
    }

    // Náº¿u gá»i API khÃ¡c khÃ´ng tá»“n táº¡i, tráº£ vá» lá»—i 404 JSON thay vÃ¬ HTML
    if (pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API Endpoint Not Found' }));
        return;
    }

    // --- ROUTING: Xá»­ lÃ½ tráº£ vá» file HTML ---
    // Máº·c Ä‘á»‹nh lÃ  index.html, náº¿u yÃªu cáº§u /releasing.html thÃ¬ tráº£ vá» file Ä‘Ã³
    let fileName = 'index.html';
    if (pathname === '/releasing.html') {
        fileName = 'releasing.html';
    }
    if (pathname === '/dso.html') {
        fileName = 'dso.html';
    }
    if (pathname === '/bbr.html') {
        fileName = 'bbr.html';
    }
    if (pathname === '/check.html') {
        fileName = 'check.html';
    }
    if (pathname === '/inventory.html') {
        fileName = 'inventory.html';
    }
    if (pathname === '/masterdata.html') {
        fileName = 'masterdata.html';
    }
    if (pathname === '/allowcate.html') {
        fileName = 'allowcate.html';
    }

    const filePath = path.join(__dirname, fileName);

    // Äá»c vÃ  tráº£ vá» file HTML
    fs.readFile(filePath, (err, content) => {
        if (err) {
            // Náº¿u khÃ´ng tÃ¬m tháº¥y file (Lá»—i 404)
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 - KhÃ´ng tÃ¬m tháº¥y trang nÃ y');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        }
    });
});

// Khá»Ÿi Ä‘á»™ng server vÃ  láº¯ng nghe á»Ÿ cá»•ng Ä‘Ã£ Ä‘á»‹nh nghÄ©a
server.listen(port, () => {
    console.log(`Server Ä‘ang cháº¡y táº¡i http://localhost:${port}/`);
});







