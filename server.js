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

const connection = mysql.createConnection({
    host: dbUrl.hostname,
    user: dbUrl.username,
    password: dbUrl.password,
    database: dbUrl.pathname.slice(1), // Loại bỏ dấu '/' ở đầu tên database
    port: dbUrl.port,
    ssl: {
        rejectUnauthorized: false // Chấp nhận chứng chỉ SSL của Aiven
    }
});

// Kiểm tra kết nối Database ngay khi khởi động server
connection.connect(err => {
    if (err) {
        console.error('❌ Lỗi kết nối Database:', err.stack);
        return;
    }
    console.log('✅ Đã kết nối thành công tới MySQL Database (Aiven)!');
});

// Tạo một server HTTP
const server = http.createServer((req, res) => {
    // Xây dựng đường dẫn đến file index.html
    const filePath = path.join(__dirname, 'index.html');

    // Đọc file index.html
    fs.readFile(filePath, (err, content) => {
        if (err) {
            // Nếu có lỗi (ví dụ: không tìm thấy file), trả về lỗi 500
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Lỗi Server');
            console.error('Lỗi khi đọc file:', err);
        } else {
            // Nếu đọc file thành công, trả về nội dung file HTML
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        }
    });
});

// Khởi động server và lắng nghe ở cổng đã định nghĩa
server.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}/`);
});
