
// ==========================================
// KHU VỰC CẤU HÌNH (CONFIG)
// ==========================================
const CONFIG = {
  SOURCE_LABEL: "snres",             // Nhãn Gmail bạn muốn quét
  DONE_LABEL: "Processed_By_GAS",    // Nhãn đánh dấu thư đã xử lý
  WEBHOOK_URL: "https://email.snres.net/receive",                   // URL Webhook nhận log (VD: https://worker.yourdomain.workers.dev)
  SHEET_ID: ""                       // ID Google Sheet. Nếu tạo GAS từ trong Sheet, cứ để trống ""
};

function doGet(e) {
  // Lấy các tham số từ URL, có fallback tránh lỗi khi chạy test thủ công không có biến e
  const targetWebhookUrl = (e && e.parameter && e.parameter.webhook_url) ? e.parameter.webhook_url : CONFIG.WEBHOOK_URL;
  const isGetData = (e && e.parameter && e.parameter.getdata === "true");

  let labelDone = GmailApp.getUserLabelByName(CONFIG.DONE_LABEL) || GmailApp.createLabel(CONFIG.DONE_LABEL);

  // Truy vấn tối ưu: Tìm trong nhãn theo CONFIG và loại trừ những thư đã 'Processed'
  const query = `label:${CONFIG.SOURCE_LABEL} -label:${CONFIG.DONE_LABEL}`;
  const threads = GmailApp.search(query, 0, 20);
  const results = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      results.push({
        id: msg.getId(),
        from: msg.getFrom(),
        to: msg.getTo(),
        subject: msg.getSubject(),
        text: msg.getPlainBody(),
        html: msg.getBody()
      });
    });

    // Đánh dấu luồng này đã xử lý
    thread.addLabel(labelDone);
  });

  // Nếu có cấu hình WEBHOOK, đẩy toàn bộ dữ liệu log qua hệ thống khác
  if (targetWebhookUrl && results.length > 0) {
    try {
      UrlFetchApp.fetch(targetWebhookUrl, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(results)
      });
    } catch (error) {
      // Bỏ qua lỗi mạng khi gọi webhook hoặc ghi log vào console GAS
    }
  }

  // Ghi log vào Google Sheet (ưu tiên SHEET_ID nếu có, nếu không sẽ tự động lấy Sheet đang gắn với script)
  if (results.length > 0) {
    try {
      const spreadsheet = CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
      if (!spreadsheet) throw new Error("Không có Google Sheet nào được kết nối");
      
      // Luôn chọn trang tính đầu tiên (từ trái sang)
      const sheet = spreadsheet.getSheets()[0];
      
      results.forEach(msg => {
        sheet.appendRow([
          new Date(),                 // Cột A: Thời gian ghi log
          msg.id,                     // Cột B: ID Thư
          msg.from,                   // Cột C: Người gửi
          msg.to,                     // Cột D: Người nhận
          msg.subject,                // Cột E: Chủ đề
          msg.text.substring(0, 1000) // Cột F: Nội dung chữ (cắt ngắn 1000 ký tự cho nhẹ file)
        ]);
      });
    } catch (error) {
      // Bỏ qua lỗi (VD: sai ID, không có quyền truy cập Sheet)
    }
  }

  // Phản hồi linh động dựa trên tham số getdata
  if (isGetData) {
    return ContentService.createTextOutput(JSON.stringify(results))
      .setMimeType(ContentService.MimeType.JSON);
  } else {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, qm: results.length }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
