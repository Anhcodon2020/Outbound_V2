// Import các module cần thiết
require('dotenv').config(); // Load biến môi trường từ file .env
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// Định nghĩa cổng mà server sẽ lắng nghe
const port = 3000;

// Tạo kết nối Database
// Parse URL từ file .env để cấu hình SSL thủ công
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

// Kiểm tra kết nối Pool (Optional)
pool.getConnection((err, connection) => {
    if (err) console.error('❌ Lỗi kết nối Database:', err.message);
    else { console.log('✅ Kết nối Database (Pool) sẵn sàng!'); connection.release(); }
});

// Tạo một server HTTP
const server = http.createServer((req, res) => {
    // Lấy đường dẫn URL mà người dùng yêu cầu
    const baseURL = 'http://' + req.headers.host + '/';
    const reqUrl = new URL(req.url, baseURL);
    const pathname = reqUrl.pathname;

    // --- API MODEL: Xử lý dữ liệu Releasing (Trả về JSON) ---
    if (pathname === '/api/releasing' && req.method === 'GET') {
        const sql = 'SELECT * FROM releasing ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            }
        });
        return; // Kết thúc xử lý
    }

    // --- API: Import Excel (Nhận dữ liệu JSON và xử lý Insert/Update) ---
    if (pathname === '/api/releasing/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const importData = JSON.parse(body);
                const results = { updated: 0, inserted: 0, errors: 0 };

                // Hàm wrapper để chạy query dạng Promise (giúp xử lý vòng lặp async)
                const query = (sql, params) => {
                    return new Promise((resolve, reject) => {
                        pool.query(sql, params, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    });
                };

                // Duyệt qua từng dòng dữ liệu gửi lên
                for (const item of importData) {
                    try {
                        // 1. Kiểm tra xem release_key và sku đã tồn tại chưa
                        const checkSql = 'SELECT id FROM releasing WHERE release_key = ? AND sku = ?';
                        const existing = await query(checkSql, [item.release_key, item.sku]);

                        if (existing.length > 0) {
                            // 2a. Nếu đã có -> Cập nhật release_qty và status
                            const updateSql = 'UPDATE releasing SET release_qty = ?, status = ? WHERE id = ?';
                            await query(updateSql, [item.release_qty, item.status, existing[0].id]);
                            results.updated++;
                        } else {
                            // 2b. Nếu chưa có -> Thêm mới
                            const insertSql = 'INSERT INTO releasing (release_key, release_date, sku, status, release_qty, change_reason) VALUES (?, ?, ?, ?, ?, ?)';
                            // Format ngày tháng nếu cần (giả sử client gửi string YYYY-MM-DD)
                            await query(insertSql, [
                                item.release_key, 
                                item.release_date, 
                                item.sku, 
                                item.status, 
                                item.release_qty,
                                'Import Excel'
                            ]);
                            results.inserted++;
                        }
                    } catch (rowErr) {
                        console.error('Lỗi dòng:', item, rowErr);
                        results.errors++;
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import hoàn tất', stats: results }));
            } catch (err) {
                console.error('Lỗi xử lý import:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi xử lý dữ liệu import' }));
            }
        });
        return; // Kết thúc xử lý, không chạy xuống phần đọc file bên dưới
    }

    // --- API MODEL: Xử lý dữ liệu DSO ---
    if (pathname === '/api/dso' && req.method === 'GET') {
        const sql = 'SELECT * FROM dso ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
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
                const results = { updated: 0, inserted: 0, errors: 0 };

                // Wrapper query promise
                const query = (sql, params) => {
                    return new Promise((resolve, reject) => {
                        pool.query(sql, params, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    });
                };

                for (const item of importData) {
                    try {
                        // 1. Kiểm tra tồn tại release_key
                        const checkSql = 'SELECT id FROM dso WHERE release_key = ?';
                        const existing = await query(checkSql, [item.release_key]);

                        if (existing.length > 0) {
                            // 2a. Nếu có: Cập nhật status_dso
                            const updateSql = 'UPDATE dso SET status_dso = ? WHERE id = ?';
                            await query(updateSql, [item.status, existing[0].id]);
                            results.updated++;
                        } else {
                            // 2b. Nếu không: Thêm mới (map child_po = huser_defined_02)
                            const insertSql = 'INSERT INTO dso (release_key, status_dso, child_po) VALUES (?, ?, ?)';
                            await query(insertSql, [
                                item.release_key,
                                item.status,
                                item.huser_defined_02 // Lấy từ cột Excel này
                            ]);
                            results.inserted++;
                        }
                    } catch (rowErr) {
                        console.error('Lỗi dòng DSO:', item, rowErr);
                        results.errors++;
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import DSO hoàn tất', stats: results }));
            } catch (err) {
                console.error('Lỗi xử lý import DSO:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi xử lý dữ liệu import' }));
            }
        });
        return;
    }

    // --- API MODEL: Xử lý dữ liệu BBR Report ---
    if (pathname === '/api/bbr' && req.method === 'GET') {
        const sql = 'SELECT * FROM bbrreport_raw ORDER BY id DESC';
        pool.query(sql, (err, results) => {
            if (err) {
                console.error('Lỗi truy vấn SQL (BBR):', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi Server', details: err.message }));
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
                const results = { updated: 0, inserted: 0, errors: 0 };

                const query = (sql, params) => {
                    return new Promise((resolve, reject) => {
                        pool.query(sql, params, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    });
                };

                for (const item of importData) {
                    try {
                        // 1. Kiểm tra tồn tại dựa trên 3 trường: child_po, parent_po, sku
                        const checkSql = 'SELECT id FROM bbrreport_raw WHERE child_po = ? AND parent_po = ? AND sku = ?';
                        const existing = await query(checkSql, [item.child_po, item.parent_po, item.sku]);

                        if (existing.length > 0) {
                            // 2a. Nếu có: Cập nhật qty_bbr
                            const updateSql = 'UPDATE bbrreport_raw SET qty_bbr = ? WHERE id = ?';
                            await query(updateSql, [item.qty_bbr, existing[0].id]);
                            results.updated++;
                        } else {
                            // 2b. Nếu không: Thêm mới
                            const insertSql = 'INSERT INTO bbrreport_raw (child_po, parent_po, sku, qty_bbr, remark) VALUES (?, ?, ?, ?, ?)';
                            await query(insertSql, [
                                item.child_po,
                                item.parent_po,
                                item.sku,
                                item.qty_bbr,
                                'Import Excel'
                            ]);
                            results.inserted++;
                        }
                    } catch (rowErr) {
                        console.error('Lỗi dòng BBR:', item, rowErr);
                        results.errors++;
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Import BBR hoàn tất', stats: results }));
            } catch (err) {
                console.error('Lỗi xử lý import BBR:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Lỗi xử lý dữ liệu import' }));
            }
        });
        return;
    }

    // Nếu gọi API khác không tồn tại, trả về lỗi 404 JSON thay vì HTML
    if (pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API Endpoint Not Found' }));
        return;
    }

    // --- ROUTING: Xử lý trả về file HTML ---
    // Mặc định là index.html, nếu yêu cầu /releasing.html thì trả về file đó
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

    const filePath = path.join(__dirname, fileName);

    // Đọc và trả về file HTML
    fs.readFile(filePath, (err, content) => {
        if (err) {
            // Nếu không tìm thấy file (Lỗi 404)
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 - Không tìm thấy trang này');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        }
    });
});

// Khởi động server và lắng nghe ở cổng đã định nghĩa
server.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}/`);
});
