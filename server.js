﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// Import cÃ¡c module cáº§n thiáº¿t
require('dotenv').config(); // Load biáº¿n mÃ´i trÆ°á»ng tá»« file .env
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// Äá»‹nh nghÄ©a cá»•ng mÃ  server sáº½ láº¯ng nghe
const port = process.env.PORT || 3000;

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
// Helper: xác định tên cột số lượng trong bảng inventory (qty_inventory hoặc qty_inventory)
async function getInventoryQtyColumn(conn) {
    const [c1] = await conn.query("SHOW COLUMNS FROM inventory LIKE 'qty_inventory'");
    if (Array.isArray(c1) && c1.length) return 'qty_inventory';
    const [c2] = await conn.query("SHOW COLUMNS FROM inventory LIKE 'qty_inventory'");
    if (Array.isArray(c2) && c2.length) return 'qty_inventory';
    return null;
}

async function hasColumn(conn, tableName, columnName) {
    const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    return Array.isArray(rows) && rows.length > 0;
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
}

function toNumberSafe(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableLockError(err) {
    return err && (
        err.code === 'ER_LOCK_WAIT_TIMEOUT' ||
        err.code === 'ER_LOCK_DEADLOCK' ||
        err.errno === 1205 ||
        err.errno === 1213
    );
}

async function runWithLockRetry(task, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await task(attempt);
        } catch (err) {
            if (!isRetryableLockError(err) || attempt === maxAttempts) throw err;
            await sleep(250 * attempt);
        }
    }
}

function pickingKey(childPo, sku) {
    return `${childPo}\u0001${sku}`;
}

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

    // --- API: Update Releasing Status ---
    if (pathname === '/api/releasing/update' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id, status, not_update } = JSON.parse(body);
                if (!id || !status) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu id hoặc status' }));
                }
                
                let sql = 'UPDATE releasing SET status = ?';
                let params = [status];
                
                // Cập nhật thêm not_update nếu có gửi lên
                if (not_update !== undefined) {
                    sql += ', not_update = ?';
                    params.push(not_update);
                }
                
                sql += ' WHERE id = ?';
                params.push(id);

                pool.query(sql, params, (err, result) => {
                    if (err) {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ message: 'Updated', affected: result.affectedRows }));
                    }
                });
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API: Delete Releasing ---
    if (pathname === '/api/releasing/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id } = JSON.parse(body);
                if (!id) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu id' }));
                }
                const sql = 'DELETE FROM releasing WHERE id = ?';
                pool.query(sql, [id], (err, result) => {
                    if (err) {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ message: 'Deleted', affected: result.affectedRows }));
                    }
                });
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API: Toggle is_checked ---
    if (pathname === '/api/releasing/toggle_check' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id, is_checked } = JSON.parse(body);
                if (!id || is_checked === undefined) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu id hoặc is_checked' }));
                }
                const sql = 'UPDATE releasing SET is_checked = ? WHERE id = ?';
                pool.query(sql, [is_checked ? 1 : 0, id], (err, result) => {
                    if (err) {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ message: 'Toggled', affected: result.affectedRows }));
                    }
                });
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API: Toggle not_update ---
    if (pathname === '/api/releasing/toggle_not_update' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id, not_update } = JSON.parse(body);
                if (!id || not_update === undefined) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu id hoặc not_update' }));
                }
                const sql = 'UPDATE releasing SET not_update = ? WHERE id = ?';
                pool.query(sql, [not_update ? 1 : 0, id], (err, result) => {
                    if (err) {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ message: 'Toggled', affected: result.affectedRows }));
                    }
                });
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API: Delete Unchecked Releasing ---
    if (pathname === '/api/releasing/delete_unchecked' && req.method === 'POST') {
        const sql = 'DELETE FROM releasing WHERE is_checked = 0';
        pool.query(sql, (err, result) => {
            if (err) {
                console.error('Lỗi xóa mục chưa check (releasing):', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi server', details: err.message }));
            } else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Deleted unchecked items', affected: result.affectedRows }));
            }
        });
        return;
    }

    // --- API: Delete All Releasing ---
    if (pathname === '/api/releasing/delete_all' && req.method === 'POST') {
        const sql = 'DELETE FROM releasing';
        pool.query(sql, (err, result) => {
            if (err) {
                console.error('Lỗi xóa sạch bảng releasing:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi server', details: err.message }));
            } else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Deleted all items', affected: result.affectedRows }));
            }
        });
        return;
    }

    // --- API: Reset is_checked for all releasing ---
    if (pathname === '/api/releasing/reset_check' && req.method === 'POST') {
        const sql = 'UPDATE releasing SET is_checked = 0';
        pool.query(sql, (err, result) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: err.message }));
            } else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Reset successful', affected: result.affectedRows }));
            }
        });
        return;
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
                // validate dữ liệu trước khi import
                const validRows = [];
                const rowErrors = [];
                for (let index = 0; index < importData.length; index++) {
                    const item = importData[index] || {};
                    const rowNumber = Number(item.__rowNum) || (index + 1);
                    const releaseKey = String(item.release_key || '').trim();
                    const sku = String(item.sku || '').trim();
                    const releaseQty = Number(item.release_qty ?? 0);
                    const originalQty = Number(item.original_qty ?? releaseQty);
                    let status = Number(item.status ?? 1);
                    
                    if (releaseQty <= 0) status = 3;

                    if (!releaseKey) {
                        rowErrors.push({ row: rowNumber, release_key: releaseKey, sku, reason: 'Thiếu release_key' });
                        continue;
                    }
                    if (!sku) {
                        rowErrors.push({ row: rowNumber, release_key: releaseKey, sku, reason: 'Thiếu SKU' });
                        continue;
                    }
                    if (!Number.isFinite(releaseQty)) {
                        rowErrors.push({ row: rowNumber, release_key: releaseKey, sku, reason: 'release_qty không hợp lệ' });
                        continue;
                    }
                    if (!Number.isInteger(status)) {
                        rowErrors.push({ row: rowNumber, release_key: releaseKey, sku, reason: 'status không hợp lệ' });
                        continue;
                    }

                    validRows.push({
                        ...item,
                        release_key: releaseKey,
                        sku,
                        release_qty: releaseQty,
                        original_qty: originalQty,
                        status: status
                    });
                }

                if (validRows.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        error: 'Không có dòng hợp lệ để import',
                        stats: {
                            inserted: 0,
                            updated: 0,
                            errors: rowErrors.length,
                            total: importData.length
                        },
                        sample_errors: rowErrors.slice(0, 20)
                    }));
                }

                const sql = `
                    INSERT INTO releasing (release_key, release_date, sku, status, release_qty, original_qty, change_reason, is_checked, not_update)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        release_qty = VALUES(release_qty),
                        original_qty = VALUES(original_qty),
                        status = VALUES(status),
                        change_reason = VALUES(change_reason),
                        is_checked = VALUES(is_checked),
                        not_update = VALUES(not_update)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(validRows, 1000)) {
                    const values = chunk.map(item => [
                        item.release_key,
                        item.release_date,
                        item.sku,
                        item.status ?? 1,
                        item.release_qty ?? 0,
                        item.original_qty ?? item.release_qty ?? 0,
                        'Import Excel',
                        1,
                        item.not_update || null
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    // affectedRows = inserted + 2*updated (MySQL behavior with ON DUP)
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    message: 'Import hoàn tất (bulk)',
                    stats: {
                        inserted,
                        updated,
                        errors: rowErrors.length,
                        total: importData.length,
                        valid_rows: validRows.length
                    },
                    sample_errors: rowErrors.slice(0, 20)
                }));
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
        const sql = `
            SELECT 
                d.*, 
                GROUP_CONCAT(DISTINCT r.sku SEPARATOR ', ') AS sku,
                GROUP_CONCAT(DISTINCT b.parent_po SEPARATOR ', ') AS parent_po
            FROM dso d
            LEFT JOIN releasing r ON d.release_key = r.release_key
            LEFT JOIN bbrreport_raw b ON d.child_po = b.child_po AND r.sku = b.sku
            GROUP BY d.id
            ORDER BY d.id DESC
        `;
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

    // --- API: Clear DSO table ---
    if (pathname === '/api/dso/clear' && req.method === 'POST') {
        const sql = 'DELETE FROM dso';
        pool.query(sql, (err, result) => {
            if (err) {
                console.error('Lỗi xóa bảng DSO:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Đã xóa toàn bộ bảng DSO', affected: result.affectedRows }));
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

                // chuẩn hóa + bỏ trùng theo release_key
                const seen = new Set();
                const deduped = [];
                for (const item of importData) {
                    const key = item.release_key;
                    if (!key) continue; // bỏ dòng không có release_key vì không upsert được
                    if (seen.has(key)) continue;
                    seen.add(key);
                    deduped.push({
                        release_key: key,
                        status: item.status ?? item.status_dso ?? 1,
                        child_po: item.huser_defined_02 ?? item.child_po ?? null
                    });
                }
                if (deduped.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Không có release_key hợp lệ' }));
                }

                const sql = `
                    INSERT INTO dso (release_key, status_dso, child_po)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        status_dso = VALUES(status_dso)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(deduped, 1000)) {
                    const values = chunk.map(item => [
                        item.release_key,
                        item.status,
                        item.child_po
                    ]);

                    const result = await new Promise((resolve, reject) => {
                        pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                    });
                    updated += result.changedRows || 0;
                    inserted += (result.affectedRows || 0) - (result.changedRows || 0);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import DSO hoàn tất (bulk)', stats: { inserted, updated, total_received: importData.length, total_deduped: deduped.length } }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }

            const normalized = (Array.isArray(results) ? results : []).map(row => ({
                id: row.id,
                child_po: row.child_po ?? row.childpo ?? '',
                parent_po: row.parent_po ?? row.parentpo ?? '',
                sku: row.sku ?? '',
                qty_bbr: row.qty_bbr ?? row.qty ?? 0,
                remark: row.remark ?? '',
                is_select: row.is_select ?? row.is_selected ?? 0
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(normalized));
        });
        return;
    }

    // --- API: BBR Report (bảng bbrreport) dùng cho allowcate_1 ---
    if (pathname === '/api/bbrreport' && req.method === 'GET') {
        pool.query('SELECT * FROM bbrreport', (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL (bbrreport):', err);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }
            const normalized = (Array.isArray(results) ? results : []).map(row => ({
                id: row.id,
                child_po: row.po ?? '',
                parent_po: row.parentpo ?? '',
                sku: row.item ?? '',
                qty_bbr: row.qty ?? 0,
                remark: row.remark ?? '',
                is_select: row.is_select ?? 0
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(normalized));
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
                    INSERT INTO bbrreport_raw (child_po, parent_po, sku, qty_bbr, remark, is_select)
                    VALUES ?
                    ON DUPLICATE KEY UPDATE 
                        qty_bbr = VALUES(qty_bbr)
                `;

                let inserted = 0, updated = 0;
                for (const chunk of chunkArray(importData, 1000)) {
                    const values = chunk
                        .filter(item => item.parent_po) // chỉ nhận nếu có PO
                        .map(item => [
                            item.child_po,
                            item.parent_po,
                            item.sku,
                            item.qty_bbr ?? 0,
                            item.remark || 'Import Excel',
                            0 // Mặc định chưa chọn khi import mới
                        ]);
                    if (values.length === 0) continue;

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

    // --- API: Cập nhật trạng thái is_select cho BBR ---
    if (pathname === '/api/bbr/update' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id, is_select } = JSON.parse(body);
                if (id === undefined) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Thiếu id' }));
                }
                const sql = 'UPDATE bbrreport_raw SET is_select = ? WHERE id = ?';
                pool.query(sql, [is_select ? 1 : 0, id], (err, result) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: 'Updated', id, is_select }));
                    }
                });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API MODEL: Check Data (Join Releasing -> DSO -> BBR) ---
    if (pathname === '/api/check' && req.method === 'GET') {
        const sql = `
            SELECT 
                r.release_key, r.release_date, r.sku, r.release_qty, 
                d.child_po, 
                b.parent_po, b.qty_bbr
            FROM releasing r
            LEFT JOIN dso d ON r.release_key = d.release_key
            LEFT JOIN bbrreport_raw b ON d.child_po = b.child_po AND r.sku = b.sku
            WHERE r.status IN (1, 3)
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
        (async () => {
            let conn;
            try {
                conn = await pool.promise().getConnection();
                const [inventoryRows] = await conn.query('SELECT * FROM inventory ORDER BY id DESC');

                let masterRows = [];
                try {
                    const [rows] = await conn.query('SELECT * FROM masterdata');
                    masterRows = Array.isArray(rows) ? rows : [];
                } catch (masterErr) {
                    console.error('Lỗi đọc masterdata khi chuẩn hóa inventory:', masterErr);
                }

                const masterMap = new Map(
                    masterRows.map(row => [
                        (firstDefined(row.sku, row.SKU) || '').toString().trim().toUpperCase(),
                        toNumberSafe(firstDefined(row.cbm, row.CBM))
                    ])
                );

                const normalized = (Array.isArray(inventoryRows) ? inventoryRows : []).map(row => {
                    const sku = firstDefined(row.sku_inventory, row.sku, row.SKU);
                    const parentPo = firstDefined(row.parent_po_invent, row.parent_po, row.user_defined_07);
                    const allocatedCtn = toNumberSafe(firstDefined(row.allocated_ctn, row.AX));
                    const qty = toNumberSafe(firstDefined(
                        row.qty_inventory,
                        row.qty_inventory,
                        row.available_ctn,
                        allocatedCtn,
                        row.onhand_carton
                    ));
                    const dateRcv = firstDefined(row.date_rcv, row.receive_date, row.date_receive);
                    const cbmPerCarton = toNumberSafe(firstDefined(row.cbm_per_carton, row.cbm));
                    const masterCbm = masterMap.get((sku || '').toString().trim().toUpperCase()) || cbmPerCarton;
                    const totalCbm = toNumberSafe(firstDefined(row.total_cbm, qty * masterCbm));

                    return {
                        ...row,
                        parent_po_invent: parentPo,
                        sku_inventory: sku,
                        qty_inventory: qty,
                        allocated_ctn: allocatedCtn,
                        date_rcv: dateRcv,
                        cbm_per_carton: cbmPerCarton || masterCbm,
                        total_cbm: totalCbm
                    };
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(normalized));
            } catch (err) {
                console.error('Lỗi truy vấn SQL (Inventory):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
            } finally {
                if (conn) conn.release();
            }
        })();
        return;
    }

    // --- API: Import Inventory (XÃ³a háº¿t cÅ© -> ThÃªm má»›i) ---
    if (pathname === '/api/inventory/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                const totalReceived = importData.length;
                const today = new Date().toISOString().split('T')[0]; // Láº¥y ngÃ y hiá»‡n táº¡i YYYY-MM-DD
                const mode = reqUrl.searchParams.get('mode');

                // 1. XÃ³a toÃ n bá»™ dá»¯ liá»‡u cÅ© (Trừ khi mode là 'merge')
                if (mode !== 'merge') {
                    await new Promise((resolve, reject) => {
                        pool.query('DELETE FROM inventory', (err) => err ? reject(err) : resolve());
                    });
                }

                let insertedCount = 0;
                // 2. Chuáº©n bá»‹ dá»¯ liá»‡u Insert (Bulk Insert cho nhanh)
                if (totalReceived > 0) {
                    // Lọc chỉ lấy những dòng có số lượng > 0 (client đã chuẩn hóa vào qty_inventory)
                    const validItems = importData.filter(item => (item.qty_inventory || 0) > 0);
                    
                    if (validItems.length > 0) {
                        const conn = await pool.promise().getConnection();
                        const hasAllocatedCtn = await hasColumn(conn, 'inventory', 'allocated_ctn');
                        conn.release();

                        const values = validItems.map(item => {
                            const base = [item.parent_po_invent, item.sku_inventory, item.qty_inventory, item.date_rcv, today, item.qty_rcv || 0];
                            if (hasAllocatedCtn) base.push(item.allocated_ctn || item.AX || 0);
                            return base;
                        });
                        const columns = hasAllocatedCtn
                            ? '(parent_po_invent, sku_inventory, qty_inventory, date_rcv, date_update, qty_rcv, allocated_ctn)'
                            : '(parent_po_invent, sku_inventory, qty_inventory, date_rcv, date_update, qty_rcv)';
                        const sql = `INSERT INTO inventory ${columns} VALUES ?`;
                        
                        const result = await new Promise((resolve, reject) => {
                            pool.query(sql, [values], (err, res) => err ? reject(err) : resolve(res));
                        });
                        insertedCount = result.affectedRows;
                    }
                }

                const filteredOutCount = totalReceived - insertedCount;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: 'Cáº­p nháº­t Inventory thÃ nh cÃ´ng', 
                    inserted: insertedCount,
                    received: totalReceived,
                    filtered: filteredOutCount
                }));
            } catch (err) {
                console.error('Lá»—i Import Inventory:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lá»—i xá»­ lÃ½ dá»¯ liá»‡u import', details: err.message }));
            }
        });
        return;
    }

    // --- API: Update Inventory Single Row ---
    if (pathname === '/api/inventory/update' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            let conn;
            try {
                const { id, qty, parent_po } = JSON.parse(body);
                if (!id || qty === undefined || qty < 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Dữ liệu không hợp lệ' }));
                }
                conn = await pool.promise().getConnection();
                const qtyCol = await getInventoryQtyColumn(conn);
                if (!qtyCol) throw new Error('Không tìm thấy cột số lượng');
                
                const today = new Date().toISOString().slice(0,10);
                
                let sql = `UPDATE inventory SET ${qtyCol} = ?, date_update = ?`;
                let params = [qty, today];
                if (parent_po !== undefined) {
                    sql += `, parent_po_invent = ?`;
                    params.push(parent_po);
                }
                sql += ` WHERE id = ?`;
                params.push(id);

                const [result] = await conn.query(sql, params);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Updated', affected: result.affectedRows }));
            } catch (err) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: err.message }));
            } finally {
                if (conn) conn.release();
            }
        });
        return;
    }

    // --- API MODEL: Inventory Allow ---
    if (pathname === '/api/inventory-allow' && req.method === 'GET') {
        const sql = `
            SELECT
                ia.*,
                COALESCE(m.cbm, 0) AS cbm_per_carton,
                COALESCE(ia.qty, 0) * COALESCE(m.cbm, 0) AS total_cbm,
                CASE
                    WHEN ia.date_rcv IS NULL THEN NULL
                    ELSE DATEDIFF(CURDATE(), ia.date_rcv)
                END AS due_date_days
            FROM invetory_allow ia
            LEFT JOIN masterdata m ON UPPER(TRIM(ia.sku)) = UPPER(TRIM(m.sku))
            ORDER BY ia.id DESC
        `;
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Loi truy van SQL (Inventory Allow):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Loi Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Import Inventory Allow ---
    if (pathname === '/api/inventory-allow/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                if (!Array.isArray(importData)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Du lieu import khong hop le' }));
                }

                const mode = reqUrl.searchParams.get('mode');
                const now = new Date();
                const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                const validItems = importData
                    .map(item => ({
                        parentPO_allow: String(item.parentPO_allow ?? '').trim(),
                        sku: String(item.sku ?? '').trim(),
                        qty: Number.parseInt(item.qty ?? 0, 10) || 0,
                        date_rcv: item.date_rcv || null,
                        qty_rcv: Number.parseInt(item.qty_rcv ?? 0, 10) || 0
                    }))
                    .filter(item => item.parentPO_allow || item.sku || item.qty || item.date_rcv || item.qty_rcv);

                if (mode !== 'merge') {
                    await new Promise((resolve, reject) => {
                        pool.query('DELETE FROM invetory_allow', (err) => err ? reject(err) : resolve());
                    });
                }

                let insertedCount = 0;
                for (const chunk of chunkArray(validItems, 1000)) {
                    const values = chunk.map(item => [
                        item.parentPO_allow,
                        item.sku,
                        item.qty,
                        item.date_rcv,
                        item.qty_rcv,
                        today
                    ]);
                    if (values.length === 0) continue;

                    const result = await new Promise((resolve, reject) => {
                        pool.query(
                            'INSERT INTO invetory_allow (parentPO_allow, sku, qty, date_rcv, qty_rcv, date_update) VALUES ?',
                            [values],
                            (err, res) => err ? reject(err) : resolve(res)
                        );
                    });
                    insertedCount += result.affectedRows || 0;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    message: 'Cap nhat Inventory Allow thanh cong',
                    received: importData.length,
                    inserted: insertedCount,
                    skipped: importData.length - validItems.length
                }));
            } catch (err) {
                console.error('Loi Import Inventory Allow:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Loi xu ly du lieu import', details: err.message }));
            }
        });
        return;
    }

    // --- API: Delete Inventory Allow Row ---
    if (pathname === '/api/inventory-allow/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', () => {
            try {
                const { id } = JSON.parse(body || '{}');
                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Thieu id' }));
                }

                pool.query('DELETE FROM invetory_allow WHERE id = ?', [id], (err, result) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Loi xoa du lieu', details: err.message }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: 'Deleted', affected: result.affectedRows }));
                    }
                });
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // --- API: Delete All Inventory Allow Rows ---
    if (pathname === '/api/inventory-allow/delete-all' && req.method === 'POST') {
        pool.query('DELETE FROM invetory_allow', (err, result) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Loi xoa tat ca du lieu', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Deleted all', affected: result.affectedRows }));
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
        const sql = 'SELECT * FROM DC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL (DC):', err);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }

            const normalized = (Array.isArray(results) ? results : []).map(row => {
                const id = row.id ?? row.ID ?? '';
                const fdc = row.fdc ?? row.FDC ?? '';
                const hubdc = row.hubdc ?? row.HUBDC ?? '';
                return {
                    id,
                    fdc,
                    hubdc,
                    code_dc: id,
                    hub_dc: hubdc,
                    hub: hubdc,
                    fdc_name: fdc
                };
            });

            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(normalized));
        });
        return;
    }

    // --- API MODEL: Nhà Cung Cấp ---
    if (pathname === '/api/nhacungcap' && req.method === 'GET') {
        const sql = 'SELECT MANCC, name_doc FROM nhacungcap ORDER BY MANCC';
        pool.query(sql, (err, results) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({ error: err.message }));
            }

            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(results));
        });
        return;
    }

    // --- API MODEL: BBR Report Detail by Parent PO and SKU ---
    if (pathname === '/api/bbr/detail' && req.method === 'GET') {
        const parentPo = reqUrl.searchParams.get('parent_po');
        const sku = reqUrl.searchParams.get('sku');

        if (!parentPo || !sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing parent_po or sku' }));
            return;
        }

        const sql = `
            SELECT 
                b.*,
                IFNULL(o.total_outbound, 0) AS qty_outbound,
                o.job_list,
                o.date_list,
                rel.release_key,
                rel.qty_release,
                rel.release_status
            FROM bbrreport_raw b
            LEFT JOIN (
                SELECT
                    TRIM(d.child_po) AS child_po_key,
                    UPPER(TRIM(r.sku)) AS sku_key,
                    TRIM(r.release_key) AS release_key,
                    SUM(IFNULL(r.release_qty, 0)) AS qty_release,
                    MAX(IFNULL(r.status, 0)) AS release_status
                FROM dso d
                INNER JOIN releasing r
                    ON TRIM(d.release_key) = TRIM(r.release_key)
                GROUP BY TRIM(d.child_po), UPPER(TRIM(r.sku)), TRIM(r.release_key)
            ) rel
                ON TRIM(b.child_po) = rel.child_po_key
               AND UPPER(TRIM(b.sku)) = rel.sku_key
            LEFT JOIN (
                SELECT
                    TRIM(parentpo) AS parentpo_key,
                    TRIM(childpo) AS childpo_key,
                    UPPER(TRIM(sku)) AS sku_key,
                    SUM(carton) AS total_outbound,
                    GROUP_CONCAT(DISTINCT jobno SEPARATOR ', ') AS job_list,
                    GROUP_CONCAT(DISTINCT DATE_FORMAT(IFNULL(datestuff, datercv), '%d/%m/%Y') SEPARATOR ', ') AS date_list
                FROM outbound
                GROUP BY TRIM(parentpo), TRIM(childpo), UPPER(TRIM(sku))
            ) o
                ON TRIM(b.parent_po) = o.parentpo_key
               AND TRIM(b.child_po) = o.childpo_key
               AND UPPER(TRIM(b.sku)) = o.sku_key
            WHERE TRIM(b.parent_po) = TRIM(?)
              AND UPPER(TRIM(b.sku)) = UPPER(TRIM(?))
            ORDER BY b.id DESC
        `;
        pool.query(sql, [String(parentPo), String(sku)], (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL (BBR Detail):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API MODEL: Inbound ---
    if (pathname === '/api/inbound' && req.method === 'GET') {
        const sql = 'SELECT * FROM inbound ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL (Inbound):', err);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([])); // Trả về mảng rỗng nếu bảng chưa tồn tại
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

    // --- API: Tra cứu số lượng carton từ Child PO và SKU (DSO -> Releasing) ---
    if (pathname === '/api/lookup/po' && req.method === 'GET') {
        const childPo = reqUrl.searchParams.get('child_po');
        const sku = reqUrl.searchParams.get('sku');

        if (!childPo || !sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing child_po or sku' }));
            return;
        }

        const sql = `
            SELECT d.release_key, r.release_qty, r.status, r.release_date
            FROM dso d
            INNER JOIN releasing r ON d.release_key = r.release_key
            WHERE d.child_po = ? AND r.sku = ?
        `;
        pool.query(sql, [childPo, sku], (err, results) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return;
    }

// --- API MODEL: Allocate (Releasing -> DSO -> BBR -> Inventory) ---
    if (pathname === '/api/allocate' && req.method === 'GET') {
        (async () => {
            let conn;
            try {
                conn = await pool.promise().getConnection();
                const hasAllocatedCtn = await hasColumn(conn, 'inventory', 'allocated_ctn');
                const allocatedSelect = hasAllocatedCtn ? 'COALESCE(i.allocated_ctn, 0)' : '0';
                const sql = `
                    SELECT 
                        r.release_key, r.release_date, r.sku, r.release_qty, r.status AS release_status,
                        d.child_po,
                        b.parent_po,
                        i.qty_inventory, ${allocatedSelect} AS allocated_ctn, i.date_rcv,
                        COALESCE(m.cbm, 0) AS cbm_per_carton,
                        COALESCE(LEAST(COALESCE(r.release_qty, 0), COALESCE(i.qty_inventory, 0)) * COALESCE(m.cbm, 0), 0) AS total_cbm,
                        CASE WHEN i.date_rcv IS NULL THEN NULL ELSE DATEDIFF(CURDATE(), i.date_rcv) END AS due_date_days
                    FROM releasing r
                    LEFT JOIN dso d ON r.release_key = d.release_key
                    LEFT JOIN bbrreport_raw b ON d.child_po = b.child_po AND r.sku = b.sku
                    LEFT JOIN inventory i ON b.parent_po = i.parent_po_invent AND r.sku = i.sku_inventory
                    LEFT JOIN masterdata m ON r.sku = m.sku
                    WHERE r.status = 1
                    ORDER BY r.release_key ASC, r.sku ASC, i.date_rcv ASC
                `;
                const [results] = await conn.query(sql);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(results));
            } catch (err) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: err.message }));
            } finally {
                if (conn) conn.release();
            }
        })();
        return;
    }

    // --- API: Check CLP (detail_pickinglist) ---
    if (pathname === '/api/check_clp' && req.method === 'GET') {
        // Trước đây chỉ lấy dòng chưa chọn (is_selected = 0) nên giao diện sẽ trống nếu tất cả đã được chọn.
        // Để màn hình luôn thấy dữ liệu và dùng bộ lọc "Is Selected" trên UI, lấy toàn bộ bảng rồi để client lọc.
        const sql = 'SELECT * FROM detail_pickinglist ORDER BY due_date+0 ASC, id ASC LIMIT 2000';
        pool.query(sql, (err, results) => {
            if (err) res.writeHead(500).end(JSON.stringify({ error: err.message }));
            else res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(results));
        });
        return;
    }

    // --- API: Update is_selected for detail_pickinglist ---
    if (pathname.startsWith('/api/check_clp/update') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const id = Number(payload.id);
                const isSelected = payload.is_selected ? 1 : 0;
                const remark = payload.remark; // Nhận thêm remark
                const cartonQty = payload.carton_qty;
                const totalCbm = payload.total_cbm;

                if (!Number.isFinite(id)) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'id không hợp lệ' }));
                }
                
                let sql = 'UPDATE detail_pickinglist SET is_selected = ?, remark = COALESCE(?, remark), updated_at = NOW()';
                let params = [isSelected, remark];

                if (cartonQty !== undefined && totalCbm !== undefined) {
                    sql += ', carton_qty = ?, total_cbm = ?';
                    params.push(cartonQty, totalCbm);
                }
                
                sql += ' WHERE id = ?';
                params.push(id);

                await new Promise((resolve, reject) => {
                    pool.query(sql, params, (err, result) => err ? reject(err) : resolve(result));
                });
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'updated', id, is_selected: isSelected }));
            } catch (err) {
                console.error('Lỗi update is_selected:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi update is_selected', details: err.message }));
            }
        });
        return;
    }

    // --- API: Bulk update is_selected for detail_pickinglist ---
    if (pathname === '/api/check_clp/update_bulk' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const updates = JSON.parse(body); // Array of { id, is_selected }
                if (!Array.isArray(updates) || updates.length === 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Dữ liệu không hợp lệ' }));
                }

                // Build query: CASE WHEN id = ... THEN ...
                const ids = updates.map(u => Number(u.id)).filter(Number.isFinite);
                if (ids.length === 0) {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ message: 'Không có ID hợp lệ' }));
                }

                let caseSql = 'CASE id';
                const params = [];
                updates.forEach(u => {
                    caseSql += ' WHEN ? THEN ?';
                    params.push(u.id, u.is_selected ? 1 : 0);
                });
                caseSql += ' END';
                params.push(ids); // For WHERE IN (?)

                const sql = `UPDATE detail_pickinglist SET is_selected = ${caseSql}, updated_at = NOW() WHERE id IN (?)`;
                
                await new Promise((resolve, reject) => {
                    pool.query(sql, params, (err, result) => err ? reject(err) : resolve(result));
                });

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Updated bulk', count: updates.length }));
            } catch (err) {
                console.error('Lỗi bulk update:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi server', details: err.message }));
            }
        });
        return;
    }

    // --- API: Clear detail_pickinglist ---
    if (pathname === '/api/check_clp/clear' && req.method === 'POST') {
        (async () => {
            let conn;
            try {
                conn = await pool.promise().getConnection();
                await conn.beginTransaction();

                // Đã bỏ logic hoàn trả tồn kho vì lúc Export Picking không còn trừ kho nữa

                await conn.query('DELETE FROM detail_pickinglist');
                await conn.commit();

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Đã xóa hết detail_pickinglist' }));
            } catch (err) {
                if (conn) await conn.rollback().catch(()=>{});
                console.error('Lỗi clear detail_pickinglist:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi clear detail_pickinglist', details: err.message }));
            } finally {
                if (conn) conn.release();
            }
        })();
        return;
    }

    // --- API: Delete unselected (is_selected = 0) from detail_pickinglist ---
    if (pathname === '/api/check_clp/delete_unselected' && req.method === 'POST') {
        const sql = 'DELETE FROM detail_pickinglist WHERE is_selected = 0';
        pool.query(sql, (err, result) => {
            if (err) {
                console.error('Lỗi xóa unselected:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi server', details: err.message }));
            } else {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Deleted unselected', affected: result.affectedRows }));
            }
        });
        return;
    }

    // --- API: Move selected CLP rows to outbound ---
    if (pathname === '/api/check_clp/outbound' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            let conn;
            try {
                const payload = JSON.parse(body || '{}');
                const ids = Array.isArray(payload.ids) ? payload.ids.map(Number).filter(Number.isFinite) : [];
                const jobno = (payload.jobno || '').trim();
                const pickingNo = (payload.picking_no || '').trim();

                if (!jobno) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu jobno' }));
                }
                if (ids.length === 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Không có id nào' }));
                }
                if (!pickingNo) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Thiếu picking_no' }));
                }

                conn = await pool.promise().getConnection();
                await conn.beginTransaction();

                // 1. Lấy dữ liệu các dòng được chọn từ detail_pickinglist
                // Không chặn theo picking_no vì Job No export là giá trị do user nhập tay,
                // còn dữ liệu gốc đã được lưu với picking_no ban đầu của job.
                let [rows] = await conn.query(`
                    SELECT d.*, m.loosecase, m.kindpallet
                    FROM detail_pickinglist d
                    LEFT JOIN masterdata m ON d.sku = m.sku
                    WHERE d.id IN (?)
                `, [ids]);

                if (!rows.length && pickingNo) {
                    [rows] = await conn.query(`
                        SELECT d.*, m.loosecase, m.kindpallet
                        FROM detail_pickinglist d
                        LEFT JOIN masterdata m ON d.sku = m.sku
                        WHERE d.id IN (?) AND d.picking_no = ?
                    `, [ids, pickingNo]);
                }

                if (!rows.length) {
                    await conn.rollback();
                    res.writeHead(404, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Không tìm thấy bản ghi phù hợp' }));
                }

                const today = new Date().toISOString().slice(0,10);
                
                // Đã bỏ logic trừ tồn kho trong Export Outbound theo yêu cầu

                // 3. Cập nhật Releasing: Status = 3 (Mapping Release Key + SKU)
                // Dùng Set để tránh update trùng nhiều lần cho cùng 1 cặp key
                const relSet = new Set();
                for (const r of rows) {
                    if (r.release_key && r.sku) {
                        relSet.add(`${r.release_key}__${r.sku}`);
                    }
                }
                for (const item of relSet) {
                    const [releaseKey, sku] = item.split('__');
                    await conn.query(
                        `UPDATE releasing
                         SET status = 3
                         WHERE release_key = ? AND sku = ?`,
                        [releaseKey, sku]
                    );
                }

                // 4. Insert vào Outbound
                const insertSql = `
                    INSERT INTO outbound
                    (jobno, rsl, parentpo, childpo, fdc, sku, carton, lct, cbm, datercv, container, seal, datestuff, looscarton, kindpallet, remark)
                    VALUES ?
                `;
                const values = rows.map(r => [
                    jobno,
                    (r.release_key || '').substring(0, 255), // Truncate release_key
                    (r.parentpo || r.parent_po || '').substring(0, 255), // Truncate parentpo
                    (r.childpo || r.child_po || '').substring(0, 255), // Truncate childpo
                    (r.childpo || r.child_po || '').toString().substring(0,3),
                    (r.sku || '').substring(0, 255), // Truncate sku
                    Number(r.carton_qty) || 0,
                    (r.loading_type || '').substring(0, 255), // Truncate loading_type
                    Number(r.total_cbm) || 0,
                    today,
                    (r.container || '').substring(0, 255), // Truncate container
                    (r.seal || '').substring(0, 255), // Truncate seal
                    r.datestuff || null,
                    r.loosecase ? r.loosecase.toString().substring(0, 50) : null,
                    r.kindpallet ? r.kindpallet.toString().substring(0, 50) : null,
                    (r.remark || '').substring(0, 255) // Truncate remark
                ]);
                
                const [insertResult] = await conn.query(insertSql, [values]);

                // 5. Xóa khỏi detail_pickinglist
                const movedIds = rows.map(r => r.id);
                await conn.query('DELETE FROM detail_pickinglist WHERE id IN (?)', [movedIds]);

                await conn.commit();

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ message: 'Đã chuyển outbound', inserted: insertResult.affectedRows || values.length, deleted: movedIds.length }));
            } catch (err) {
                if (conn) await conn.rollback().catch(()=>{});
                console.error('Lỗi chuyển outbound:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi chuyển outbound', details: err.message }));
            } finally {
                if (conn) conn.release();
            }
        });
        return;
    }

    // --- API: Split carton for detail_pickinglist ---
    if (pathname.startsWith('/api/check_clp/split') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            let conn;
            try {
                const payload = JSON.parse(body || '{}');
                const origId = Number(payload.id);
                const splitCarton = Number(payload.split_carton);
                if (!Number.isFinite(origId) || !Number.isFinite(splitCarton) || splitCarton <= 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Dữ liệu tách không hợp lệ' }));
                }

                conn = await pool.promise().getConnection();
                await conn.beginTransaction();

                const [originalRows] = await conn.query(
                    'SELECT * FROM detail_pickinglist WHERE id = ? FOR UPDATE',
                    [origId]
                );
                const original = originalRows[0];
                if (!original) {
                    await conn.rollback();
                    res.writeHead(404, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Không tìm thấy record gốc' }));
                }

                const cartonQty = Number(original.carton_qty) || 0;
                if (splitCarton >= cartonQty) {
                    await conn.rollback();
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Dữ liệu tách không hợp lệ' }));
                }

                const cbmPer = Number(original.cbm_per_carton) || 0;
                const remainCarton = cartonQty - splitCarton;
                const remainCbm = cbmPer * remainCarton;
                const newCarton = splitCarton;
                const newCbm = cbmPer * newCarton;

                // update original
                await conn.query(
                    'UPDATE detail_pickinglist SET carton_qty = ?, total_cbm = ?, updated_at = NOW() WHERE id = ?',
                    [remainCarton, remainCbm, origId]
                );

                const insertSql = `
                    INSERT INTO detail_pickinglist
                    (picking_date, picking_no, source_file, hubdc, fdc, sku, sku_name, carton_qty,
                     length_cm, width_cm, height_cm, cbm_per_carton, total_cbm, loading_type, is_selected,
                     remark, release_key, due_date, parentpo, childpo)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `;
                const insertValues = [
                    original.picking_date,
                    original.picking_no,
                    original.source_file,
                    original.hubdc,
                    original.fdc,
                    original.sku,
                    original.sku_name,
                    newCarton,
                    original.length_cm,
                    original.width_cm,
                    original.height_cm,
                    cbmPer,
                    newCbm,
                    original.loading_type,
                    original.is_selected,
                    original.remark,
                    original.release_key,
                    original.due_date,
                    original.parentpo,
                    original.childpo
                ];
                const [insertResult] = await conn.query(insertSql, insertValues);
                await conn.commit();
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    message: 'split_ok',
                    updated: { id: origId, carton_qty: remainCarton, total_cbm: remainCbm },
                    inserted: { id: insertResult.insertId, carton_qty: newCarton, total_cbm: newCbm }
                }));
            } catch (err) {
                if (conn) await conn.rollback().catch(()=>{});
                console.error('Lỗi split carton:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi split carton', details: err.message }));
            } finally {
                if (conn) conn.release();
            }
        });
        return;
    }

    // --- API: Export picking list (insert các dòng được chọn) ---
    if (pathname === '/api/picking/export' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const rows = JSON.parse(body);
                if (!Array.isArray(rows) || rows.length === 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    return res.end(JSON.stringify({ error: 'Không có dòng nào để export' }));
                }

                const today = new Date();
                const ymd = today.toISOString().slice(0,10);
                const pickingNo = `Job${ymd.replace(/-/g, '')}`;
                
                try {
                    const exportResult = await runWithLockRetry(async () => {
                        let conn;
                        let transactionStarted = false;
                        try {
                            conn = await pool.promise().getConnection();

                            const lookupItems = rows
                                .map(item => ({
                                    childPo: item.childpo || item.child_po || '',
                                    sku: item.sku || ''
                                }))
                                .filter(item => item.childPo && item.sku);
                            const uniqueLookupItems = Array.from(
                                new Map(lookupItems.map(item => [pickingKey(item.childPo, item.sku), item])).values()
                            );

                            const existingIds = [];
                            const existingKeys = new Set();
                            for (const chunk of chunkArray(uniqueLookupItems, 500)) {
                                const placeholders = chunk.map(() => '(?, ?)').join(', ');
                                const params = chunk.flatMap(item => [item.childPo, item.sku]);
                                const [existingRows] = await conn.query(
                                    `SELECT id, childpo, sku FROM detail_pickinglist WHERE (childpo, sku) IN (${placeholders})`,
                                    params
                                );
                                for (const row of existingRows) {
                                    if (row.id) existingIds.push(Number(row.id));
                                    existingKeys.add(pickingKey(row.childpo || '', row.sku || ''));
                                }
                            }

                            const toInsert = [];
                            for (const item of rows) {
                                const childPo = item.childpo || item.child_po || '';
                                const sku = item.sku || '';
                                const exists = childPo && sku && existingKeys.has(pickingKey(childPo, sku));

                                if (!exists) {
                                    const releaseQty = Number(item.release_qty) || 0;
                                    const invQty = Number(item.qty_inventory) || 0;
                                    const cartonQty = releaseQty < invQty ? releaseQty : invQty;
                                    const cbmPerCarton = Number(item.cbm_per_carton) || 0;
                                    const totalCbm = cbmPerCarton * cartonQty;
                                    
                                    let dueDate = ymd;
                                    if (item.date_rcv) {
                                        const rcv = new Date(item.date_rcv);
                                        const diffMs = today - rcv;
                                        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                                        dueDate = Number.isFinite(diffDays) ? String(diffDays) : ymd;
                                    }

                                    toInsert.push([
                                        ymd, pickingNo, item.source_file||null, item.hubdc||'', item.fdc||'',
                                        sku, item.sku_name||null, cartonQty,
                                        item.length_cm||null, item.width_cm||null, item.height_cm||null,
                                        cbmPerCarton, totalCbm, item.loading_type||'PALLET',
                                        (item.is_selected !== undefined ? item.is_selected : 1), 
                                        item.remark||null, item.release_key||null, dueDate,
                                        item.parentpo || item.parent_po || null, childPo
                                    ]);
                                }
                            }

                            await conn.beginTransaction();
                            transactionStarted = true;

                            // Update by primary key instead of childpo + sku to keep row locks as narrow as possible.
                            const uniqueExistingIds = Array.from(new Set(existingIds.filter(Number.isFinite)));
                            for (const idChunk of chunkArray(uniqueExistingIds, 1000)) {
                                await conn.query(
                                    'UPDATE detail_pickinglist SET is_selected = 1, updated_at = NOW() WHERE id IN (?) AND (is_selected <> 1 OR is_selected IS NULL)',
                                    [idChunk]
                                );
                            }

                            if (toInsert.length > 0) {
                                const sqlInsert = `
                                    INSERT INTO detail_pickinglist
                                    (picking_date, picking_no, source_file, hubdc, fdc, sku, sku_name, carton_qty,
                                     length_cm, width_cm, height_cm, cbm_per_carton, total_cbm, loading_type, is_selected,
                                     remark, release_key, due_date, parentpo, childpo)
                                    VALUES ?
                                `;
                                for (const insertChunk of chunkArray(toInsert, 1000)) {
                                    await conn.query(sqlInsert, [insertChunk]);
                                }
                            }

                            await conn.commit();
                            transactionStarted = false;
                            return { inserted: toInsert.length, updated: rows.length - toInsert.length };
                        } catch (err) {
                            if (conn && transactionStarted) await conn.rollback().catch(()=>{});
                            throw err;
                        } finally {
                            if (conn) conn.release();
                        }
                    });

                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ 
                        message: 'Đã xử lý picking list', 
                        inserted: exportResult.inserted, 
                        updated: exportResult.updated,
                        picking_no: pickingNo 
                    }));
                } catch (err) {
                    throw err;
                }
            } catch (err) {
                console.error('Lỗi export picking:', err);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Lỗi export picking', details: err.message }));
            }
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
    if (pathname === '/allowcate_1.html') {
        fileName = 'allowcate_1.html';
    }
    if (pathname === '/inventory_allowcate.html') {
        fileName = 'inventory_allowcate.html';
    }
    if (pathname === '/check_clp.html') {
        fileName = 'check_clp.html';
    }
    if (pathname === '/create_picking_list.html') {
        fileName = 'create_picking_list.html';
    }
    if (pathname === '/pallet.html') {
        fileName = 'pallet.html';
    }
    if (pathname === '/palletizing_ui.html') {
        fileName = 'palletizing_ui.html';
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
