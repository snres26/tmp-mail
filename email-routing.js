export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        const commonHeaders = {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        };

        if (method === "OPTIONS") return new Response(null, { headers: commonHeaders });

        // --- ROUTE 0: FRONTEND (UI) ---
        if (path === "/" || path === "/index.html") {
            return new Response(generateHTML(), {
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "public, max-age=86400"
                },
            });
        }

        // --- ROUTE 1: LẤY HTML EMAIL ---
        if (path === "/html") {
            const id = url.searchParams.get("id");
            if (!id) return new Response("Thiếu ID", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
            try {
                // Fetch HTML content from D1
                const { results } = await env.DB.prepare("SELECT html_content FROM emails WHERE id = ?1").bind(id).all();
                const emailEntry = results.length > 0 ? results[0] : null;

                if (emailEntry && emailEntry.html_content) {
                    return new Response(emailEntry.html_content, {
                        headers: {
                            "Content-Type": "text/html; charset=utf-8",
                            "Access-Control-Allow-Origin": "*",
                            "Cache-Control": "public, max-age=31536000, immutable"
                        },
                    });
                }
                return new Response("Không tìm thấy nội dung", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
            } catch (e) {
                console.error("Error fetching email HTML from D1:", e);
                return new Response("Lỗi hệ thống", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
            }
        }

        // --- ROUTE 2: LOGIN ---
        if (path === "/api/login" && method === "POST") {
            try {
                const { email, password } = await request.json();
                if (!email || !password) return new Response(JSON.stringify({ error: "Thiếu thông tin" }), { status: 400, headers: commonHeaders });
 
                const { results } = await env.DB.prepare("SELECT password FROM users WHERE email = ?1").bind(email).all();
                const user = results.length > 0 ? results[0] : null;

                if (!user || user.password !== password) return new Response(JSON.stringify({ error: "Sai mật khẩu hoặc tài khoản không tồn tại" }), { status: 401, headers: commonHeaders });

                const token = crypto.randomUUID();
                // Session token in KV is fine and recommended for ephemeral data
                await env.TK.put(token, email, { expirationTtl: 3600 });
                return new Response(JSON.stringify({ status: "success", token }), { headers: commonHeaders });
            } catch (e) {
                console.error("Auth Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 3: DANH SÁCH EMAIL ---
        if (path === "/api/emails" && method === "GET") {
            const authHeader = request.headers.get("Authorization");
            const token = authHeader?.replace("Bearer ", "");
            const useremail = await env.TK.get(token);
            if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

            const emailIdParam = url.searchParams.get("id");

            try {
                let emails;
                if (emailIdParam) {
                    // If an ID is provided, fetch that specific email (if it belongs to the user)
                    const { results } = await env.DB.prepare(
                        "SELECT id, sender AS `from`, receiver AS `to`, subject, text_content AS `text`, created_at FROM emails WHERE id = ?1 AND receiver = ?2 ORDER BY created_at DESC"
                    ).bind(emailIdParam, useremail).all();
                    emails = results;
                } else {
                    // Otherwise, fetch all emails for the user
                    // Tối ưu: Chỉ lấy các trường cần thiết cho giao diện danh sách để giảm kích thước payload.
                    const { results } = await env.DB.prepare(
                        "SELECT id, sender AS `from`, subject, created_at FROM emails WHERE receiver = ?1 ORDER BY created_at DESC LIMIT 50"
                    ).bind(useremail).all();
                    emails = results;
                }

                // Format the date to match the previous GAS output if needed, or keep ISO string
                const formattedEmails = emails.map(email => ({
                    ...email,
                    date: new Date(email.created_at).toLocaleString('vi-VN', {
                        year: 'numeric',
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    })
                }));
                return new Response(JSON.stringify({ status: "success", data: { emails: formattedEmails } }), { headers: commonHeaders });
            } catch (e) {
                console.error("Error fetching emails from D1:", e);
                return new Response(JSON.stringify({ error: "Lỗi khi lấy danh sách email" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 4: ĐỔI MẬT KHẨU ---
        if (path === "/api/change-password" && method === "POST") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { oldPassword, newPassword } = await request.json();
                if (!oldPassword || !newPassword) return new Response(JSON.stringify({ error: "Thiếu thông tin" }), { status: 400, headers: commonHeaders });

                const { results } = await env.DB.prepare("SELECT password FROM users WHERE email = ?1").bind(useremail).all();
                const user = results.length > 0 ? results[0] : null;

                if (!user || user.password !== oldPassword) return new Response(JSON.stringify({ error: "Mật khẩu cũ không chính xác" }), { status: 401, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET password = ?1 WHERE email = ?2").bind(newPassword, useremail).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Change Password Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 5: KẾT NỐI TELEGRAM ---
        if (path === "/api/connect-telegram" && method === "POST") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { chatId } = await request.json();
                if (!chatId) return new Response(JSON.stringify({ error: "Thiếu Chat ID" }), { status: 400, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET telegram_id = ?1 WHERE email = ?2").bind(chatId, useremail).run();

                // Gửi tin nhắn test qua Telegram Bot
                try {
                    await fetch("https://bot.snres.net/sendMessage", {
                        method: "POST",
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                        body: JSON.stringify({
                            chatId: chatId,
                            text: `✅ Kết nối thành công!\n\nTài khoản email ${useremail} của bạn đã được liên kết với SNRES Bot. Từ bây giờ, thông báo email mới sẽ được chuyển thẳng về đây.`
                        })
                    });
                } catch (err) {
                    console.error("Lỗi gửi tin nhắn test Telegram:", err);
                }

                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Connect Telegram Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 6: LẤY TRẠNG THÁI TELEGRAM ---
        if (path === "/api/connect-telegram" && method === "GET") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { results } = await env.DB.prepare("SELECT telegram_id FROM users WHERE email = ?1").bind(useremail).all();
                const chatId = results.length > 0 ? results[0].telegram_id : null;
                return new Response(JSON.stringify({ chatId: chatId || "" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Get Telegram Status Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 7: XÓA KẾT NỐI TELEGRAM ---
        if (path === "/api/connect-telegram" && method === "DELETE") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET telegram_id = NULL WHERE email = ?1").bind(useremail).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Delete Telegram Connection Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 8: LẤY TRẠNG THÁI MESSENGER ---
        if (path === "/api/connect-messenger" && method === "GET") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { results } = await env.DB.prepare("SELECT messenger_apikey FROM users WHERE email = ?1").bind(useremail).all();
                const apiKey = results.length > 0 ? results[0].messenger_apikey : null;
                return new Response(JSON.stringify({ apiKey: apiKey || "" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Get Messenger Status Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 9: KẾT NỐI MESSENGER ---
        if (path === "/api/connect-messenger" && method === "POST") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { apiKey } = await request.json();
                if (!apiKey) return new Response(JSON.stringify({ error: "Thiếu API Key" }), { status: 400, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET messenger_apikey = ?1 WHERE email = ?2").bind(apiKey, useremail).run();

                // Gửi tin nhắn test qua CallMeBot Messenger
                try {
                    const testText = `✅ Kết nối thành công!\n\nTài khoản email ${useremail} của bạn đã được liên kết với Messenger. Từ bây giờ, thông báo email mới sẽ được chuyển thẳng về đây.`;
                    await fetch(`https://api.callmebot.com/facebook/send.php?apikey=${apiKey}&text=${encodeURIComponent(testText)}`);
                } catch (err) {
                    console.error("Lỗi gửi tin nhắn test Messenger:", err);
                }

                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Connect Messenger Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 10: XÓA KẾT NỐI MESSENGER ---
        if (path === "/api/connect-messenger" && method === "DELETE") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET messenger_apikey = NULL WHERE email = ?1").bind(useremail).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Delete Messenger Connection Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 11: LẤY TRẠNG THÁI ZALO ---
        if (path === "/api/connect-zalo" && method === "GET") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { results } = await env.DB.prepare("SELECT zalo_id FROM users WHERE email = ?1").bind(useremail).all();
                const chatId = results.length > 0 ? results[0].zalo_id : null;
                return new Response(JSON.stringify({ chatId: chatId || "" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Get Zalo Status Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 12: KẾT NỐI ZALO ---
        if (path === "/api/connect-zalo" && method === "POST") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                const { chatId } = await request.json();
                if (!chatId) return new Response(JSON.stringify({ error: "Thiếu Chat ID" }), { status: 400, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET zalo_id = ?1 WHERE email = ?2").bind(chatId, useremail).run();

                // Gửi tin nhắn test qua Zalo
                try {
                    await fetch("https://bot.snres.net/sendMessageZalo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                        body: JSON.stringify({
                            chatId: chatId,
                            text: `✅ Kết nối thành công!\n\nTài khoản email ${useremail} của bạn đã được liên kết với Zalo Bot. Từ bây giờ, thông báo email mới sẽ được chuyển thẳng về đây.`
                        })
                    });
                } catch (err) {
                    console.error("Lỗi gửi tin nhắn test Zalo:", err);
                }

                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Connect Zalo Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 13: XÓA KẾT NỐI ZALO ---
        if (path === "/api/connect-zalo" && method === "DELETE") {
            try {
                const authHeader = request.headers.get("Authorization");
                const token = authHeader?.replace("Bearer ", "");
                const useremail = await env.TK.get(token);
                if (!useremail) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: commonHeaders });

                await env.DB.prepare("UPDATE users SET zalo_id = NULL WHERE email = ?1").bind(useremail).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: commonHeaders });
            } catch (e) {
                console.error("Delete Zalo Connection Error:", e);
                return new Response(JSON.stringify({ error: "Lỗi xử lý phía máy chủ" }), { status: 500, headers: commonHeaders });
            }
        }

        // --- ROUTE 14: NHẬN EMAIL TỪ GOOGLE APP SCRIPT ---
        if (path === "/receive" && method === "POST") {
            try {
                const emails = await request.json();

                if (!Array.isArray(emails)) {
                    return new Response(
                        JSON.stringify({ error: 'Invalid payload: Expected an array.' }), 
                        { status: 400, headers: commonHeaders }
                    );
                }

                // Sửa lỗi cú pháp tại đây: Thêm await và đóng ngoặc đúng cách
                await processEmailsFromGAS(emails, env);

                return new Response(
                    JSON.stringify({ status: "success", received: emails.length }), 
                    { headers: commonHeaders }
                );

            } catch (e) {
                console.error("Error in /receive endpoint:", e);
                return new Response(
                    JSON.stringify({ error: 'Error processing request', details: e.message }), 
                    { status: 500, headers: commonHeaders }
                );
            }
        }

        return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },

    async email(message, env, ctx) {
        // Handler này có 2 nhiệm vụ:
        // 1. Chuyển tiếp email đến tài khoản Gmail để GAS có thể quét.
        // 2. Kích hoạt GAS chạy ngay lập tức thông qua webhook URL (env.TKH) thay vì chờ trigger theo thời gian.
        
        // Tác vụ 1: Chuyển tiếp email
        const forwardTask = message.forward("snres26@gmail.com");

        // Tác vụ 2: Kích hoạt Google App Script. Không cần await, để nó chạy trong nền.
        const triggerTask = fetch(env.TKH).catch(err => {
            console.error("Lỗi khi kích hoạt Google App Script:", err.message);
        });

        // Sử dụng ctx.waitUntil để đảm bảo cả hai tác vụ được thực hiện ngay cả khi response đã được gửi đi.
        ctx.waitUntil(Promise.all([forwardTask, triggerTask]));
    }
};

async function processEmailsFromGAS(emails, env) {
    for (const email of emails) {
        try {
            // 1. Lưu email vào D1. Dùng INSERT OR REPLACE để tránh lỗi trùng lặp nếu GAS gửi lại.
            await env.DB.prepare(
                `INSERT OR REPLACE INTO emails (id, sender, receiver, subject, text_content, html_content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
            ).bind(
                email.id, // ID từ Gmail
                email.from,
                email.to,
                email.subject,
                email.text,
                email.html,
                new Date().toISOString()
            ).run();

            // 2. Lấy cài đặt thông báo của người nhận
            const { results } = await env.DB.prepare(
                "SELECT telegram_id, messenger_apikey, zalo_id FROM users WHERE email = ?1"
            ).bind(email.to).all();
            const connections = results.length > 0 ? results[0] : null;

            if (!connections) {
                console.log(`No notification connections found for user ${email.to}`);
                continue; // Bỏ qua và xử lý email tiếp theo
            }

            // 3. Chuẩn bị dữ liệu để gửi thông báo
            const emailData = {
                from: email.from,
                to: email.to,
                subject: email.subject,
                text: (email.text || '').substring(0, 200) + ((email.text || '').length > 200 ? '...' : ''),
                view_html_link: `${env.WORKER_URL}/html?id=${email.id}`
            };

            // 4. Gửi thông báo
            if (connections.telegram_id) {
                const teleText = `📩 BẠN CÓ EMAIL MỚI!\n\n` +
                                `Từ: ${emailData.from}\n` +
                                `Chủ đề: ${emailData.subject}\n\n` +
                                `Tóm tắt: ${emailData.text}`;
                await fetch("https://bot.snres.net/sendMessage", {
                    method: "POST",
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                    body: JSON.stringify({
                        chatId: connections.telegram_id,
                        text: teleText,
                        reply_markup: {
                            inline_keyboard: [[{ text: "🔗 Xem tin đầy đủ", url: emailData.view_html_link }]]
                        }
                    })
                }).catch(err => console.error("Lỗi gửi thông báo Telegram:", err));
            }

            if (connections.messenger_apikey) {
                const messText = `📩 BẠN CÓ EMAIL MỚI!\n\n` +
                                 `Từ: ${emailData.from}\n` +
                                 `Chủ đề: ${emailData.subject}\n\n` +
                                 `Tóm tắt: ${emailData.text}\n` +
                                 `🔗 Xem tại: ${emailData.view_html_link}`;
                await fetch(`https://api.callmebot.com/facebook/send.php?apikey=${connections.messenger_apikey}&text=${encodeURIComponent(messText)}`)
                    .catch(err => console.error("Lỗi gửi thông báo Messenger:", err));
            }

            if (connections.zalo_id) {
                const zaloText = `📩 BẠN CÓ EMAIL MỚI!\n\n` +
                                 `Từ: ${emailData.from}\n` +
                                 `Chủ đề: ${emailData.subject}\n\n` +
                                 `Tóm tắt: ${emailData.text}\n` +
                                 `🔗 Xem tại: ${emailData.view_html_link}`;
                await fetch("https://bot.snres.net/sendMessageZalo", {
                    method: "POST",
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                    body: JSON.stringify({ chatId: connections.zalo_id, text: zaloText })
                }).catch(err => console.error("Lỗi gửi thông báo Zalo:", err));
            }

        } catch (err) {
            console.error(`Failed to process email with ID ${email.id}:`, err);
        }
    }
}

function generateHTML() {
    return `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://cdn.tailwindcss.com">
    <link rel="preconnect" href="https://cdnjs.cloudflare.com">
    <link rel="preconnect" href="https://cdn.jsdelivr.net">
    <title>SN MailBox - Professional</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <style>
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .email-item.active { border-left: 4px solid #2563eb; background-color: #eff6ff; }
        iframe { border: none; width: 100%; height: 100%; }
        #viewer-container { transition: transform 0.3s ease-in-out; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 font-sans overflow-hidden">
    <div id="app" class="h-screen flex flex-col">
        <div id="auth-section" class="flex-1 flex items-center justify-center p-4">
            <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-100">
                <div class="text-center mb-8">
                    <div class="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200">
                        <i class="fas fa-envelope-open-text text-white text-2xl"></i>
                    </div>
                    <h2 id="auth-title" class="text-2xl font-bold text-slate-800">SNRES MAILBOX</h2>
                </div>
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Tài khoản</label>
                        <div class="flex">
                            <input type="text" id="username" class="w-full px-4 py-2 border border-slate-200 rounded-l-lg outline-none focus:ring-2 focus:ring-blue-500 focus:z-10" placeholder="ten-nguoi-dung">
                            <span class="inline-flex items-center px-3 rounded-r-lg border border-l-0 border-slate-200 bg-slate-100 text-slate-500 text-sm font-medium">
                                @snres.net
                            </span>
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Mật khẩu</label>
                        <div class="relative">
                            <input type="password" id="password" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 pr-10" placeholder="••••••••">
                            <button type="button" onclick="togglePassword()" class="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400">
                                <i id="toggleIcon" class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                    <button onclick="handleAuth()" id="auth-btn" class="w-full bg-blue-600 text-white font-bold py-2.5 rounded-lg hover:bg-blue-700 active:scale-95 transition">Đăng nhập</button>
                </div>
            </div>
        </div>

        <div id="dashboard-section" class="hidden flex-1 flex flex-col overflow-hidden">
            <header class="bg-white border-b px-4 py-3 flex justify-between items-center shadow-sm z-30">
                <div class="flex items-center gap-2">
                    <div class="bg-blue-600 p-1.5 rounded text-white text-sm"><i class="fas fa-inbox"></i></div>
                    <h1 class="font-bold text-lg">SN Mail</h1>
                </div>
                <div class="relative inline-block text-left" id="user-menu-container">
                    <button onclick="toggleUserMenu()" class="flex items-center gap-2 focus:outline-none hover:opacity-80 transition">
                        <div class="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-600 flex items-center justify-center font-bold">
                            <i class="fas fa-user text-sm"></i>
                        </div>
                        <span id="user-display" class="hidden sm:inline text-xs font-bold text-slate-700"></span>
                        <i class="fas fa-chevron-down text-[10px] text-slate-400"></i>
                    </button>
                    
                    <div id="user-dropdown" class="hidden absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-100 py-2 z-50">
                        <button onclick="changePassword()" class="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-3 transition">
                            <i class="fas fa-key w-4 text-center text-slate-400"></i> Đổi mật khẩu
                        </button>
                        <button onclick="connectTelegram()" class="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-3 transition">
                            <i class="fab fa-telegram w-4 text-center text-blue-500"></i> Kết nối Telegram
                        </button>
                        <button onclick="connectMessenger()" class="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-3 transition">
                            <i class="fab fa-facebook-messenger w-4 text-center text-blue-600"></i> Kết nối Messenger
                        </button>
                        <button onclick="connectZalo()" class="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-3 transition">
                            <i class="fas fa-comment w-4 text-center text-blue-500"></i> Kết nối Zalo
                        </button>
                        <div class="border-t border-slate-100 my-1"></div>
                        <button onclick="logout()" class="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 flex items-center gap-3 font-medium transition">
                            <i class="fas fa-sign-out-alt w-4 text-center"></i> Đăng xuất
                        </button>
                    </div>
                </div>
            </header>

            <main class="flex-1 flex overflow-hidden relative">
                <aside class="w-full md:w-80 lg:w-96 bg-white border-r flex flex-col">
                    <div class="p-4 border-b flex justify-between items-center bg-slate-50/50">
                        <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Hộp thư đến</span>
                        <button onclick="loadEmails()" class="text-blue-600 hover:rotate-180 transition-transform duration-500">
                            <i class="fas fa-sync-alt text-xs"></i>
                        </button>
                    </div>
                    <div id="email-list" class="flex-1 overflow-y-auto"></div>
                </aside>

                <section id="viewer-container" class="fixed inset-0 z-40 md:z-0 bg-white transform translate-x-full md:relative md:translate-x-0 md:flex md:flex-1 flex flex-col">
                    <div class="md:hidden p-4 border-b flex items-center gap-4">
                        <button onclick="closeEmail()" class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100"><i class="fas fa-arrow-left"></i></button>
                        <span class="font-bold">Quay lại</span>
                    </div>

                    <div id="viewer-placeholder" class="hidden md:flex flex-1 flex-col items-center justify-center text-slate-300">
                        <i class="fas fa-envelope-open text-5xl mb-4"></i>
                        <p class="font-bold text-sm">Chọn một thư để đọc</p>
                    </div>
                    
                    <div id="viewer-content" class="hidden flex-1 flex flex-col overflow-hidden">
                        <div class="p-4 md:p-8 border-b border-slate-50 flex-none">
                            <h2 id="view-subject" class="text-lg md:text-2xl font-black text-slate-800 mb-3 leading-tight"></h2>
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold" id="view-avatar">?</div>
                                <div class="min-w-0">
                                    <div id="view-from" class="text-sm font-bold text-slate-700 truncate"></div>
                                    <div id="view-date" class="text-[10px] text-slate-400 font-bold uppercase mt-0.5"></div>
                                </div>
                            </div>
                        </div>
                        <div class="flex-1 bg-white overflow-hidden">
                            <iframe id="email-viewer"></iframe>
                        </div>
                    </div>
                </section>
            </main>
        </div>
        
        <!-- Modal Đổi Mật Khẩu -->
        <div id="password-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm transition-opacity">
            <div class="bg-white rounded-2xl w-full max-w-sm p-6 shadow-2xl transform transition-all mx-4">
                <div class="flex justify-between items-center mb-5">
                    <h3 class="text-lg font-bold text-slate-800">Đổi mật khẩu</h3>
                    <button onclick="closePasswordModal()" class="text-slate-400 hover:text-slate-700 transition"><i class="fas fa-times"></i></button>
                </div>
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Mật khẩu cũ</label>
                        <input type="password" id="old-password" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập mật khẩu hiện tại">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Mật khẩu mới</label>
                        <input type="password" id="new-password" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập mật khẩu mới">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Xác nhận mật khẩu mới</label>
                        <input type="password" id="confirm-password" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập lại mật khẩu mới">
                    </div>
                    <button onclick="submitChangePassword()" id="btn-change-pwd" class="w-full bg-blue-600 text-white font-bold py-2.5 rounded-lg hover:bg-blue-700 active:scale-95 transition mt-2">Cập nhật mật khẩu</button>
                </div>
            </div>
        </div>
        
        <!-- Modal Kết nối Telegram -->
        <div id="telegram-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm transition-opacity">
            <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl transform transition-all mx-4">
                <div class="flex justify-between items-center mb-5">
                    <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <i class="fab fa-telegram text-blue-500"></i> Kết nối Telegram
                    </h3>
                    <button onclick="closeTelegramModal()" class="text-slate-400 hover:text-slate-700 transition"><i class="fas fa-times"></i></button>
                </div>
                <div class="space-y-4 text-sm text-slate-600">
                    <p><strong>Bước 1:</strong> Tìm kiếm <a href="https://t.me/snresbot" target="_blank" class="text-blue-600 font-bold hover:underline">@snresbot</a> trên Telegram.</p>
                    <p><strong>Bước 2:</strong> Nhập lệnh <code class="bg-slate-100 px-1.5 py-0.5 rounded text-pink-600 font-mono">/getchatid</code> vào khung chat để nhận Chat ID của bạn.</p>
                    <p><strong>Bước 3:</strong> Nhập Chat ID của bạn vào ô bên dưới:</p>
                    <div>
                        <input type="text" id="telegram-chatid" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập Chat ID của bạn">
                    </div>
                    <p class="text-xs text-slate-500 italic mt-2"><i class="fas fa-info-circle"></i> Khi bạn có email mới, chúng tôi sẽ chuyển thành tin nhắn gửi cho bạn.</p>
                    
                    <div class="pt-2 flex gap-3">
                        <button onclick="deleteTelegramConnection()" id="btn-delete-tele" class="hidden w-1/3 bg-red-50 text-red-600 font-bold py-2.5 rounded-lg hover:bg-red-100 active:scale-95 transition">Xóa</button>
                        <button onclick="submitConnectTelegram()" id="btn-connect-tele" class="flex-1 bg-blue-500 text-white font-bold py-2.5 rounded-lg hover:bg-blue-600 active:scale-95 transition">Kết nối</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal Kết nối Messenger -->
        <div id="messenger-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm transition-opacity">
            <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl transform transition-all mx-4">
                <div class="flex justify-between items-center mb-5">
                    <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <i class="fab fa-facebook-messenger text-blue-600"></i> Kết nối Messenger
                    </h3>
                    <button onclick="closeMessengerModal()" class="text-slate-400 hover:text-slate-700 transition"><i class="fas fa-times"></i></button>
                </div>
                <div class="space-y-4 text-sm text-slate-600">
                    <p><strong>Bước 1:</strong> Mở <a href="https://m.me/api.callmebot" target="_blank" class="text-blue-600 font-bold hover:underline">CallMeBot</a> trên Messenger.</p>
                    <p><strong>Bước 2:</strong> Gửi một tin nhắn <code>create apikey</code> cho CallMeBot. Bạn sẽ nhận được phản hồi chứa API Key như sau: <br><em class="text-xs text-slate-500">"APIKey created for your Facebook<br>Account: <strong>[apikey của bạn]</strong><br>Congratulations!..."</em></p>
                    <p><strong>Bước 3:</strong> Nhập API Key của bạn vào ô bên dưới:</p>
                    <div>
                        <input type="text" id="messenger-apikey" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập API Key của bạn">
                    </div>
                    <p class="text-xs text-slate-500 italic mt-2"><i class="fas fa-info-circle"></i> Khi bạn có email mới, chúng tôi sẽ chuyển thành tin nhắn gửi cho bạn.</p>
                    
                    <div class="pt-2 flex gap-3">
                        <button onclick="deleteMessengerConnection()" id="btn-delete-mess" class="hidden w-1/3 bg-red-50 text-red-600 font-bold py-2.5 rounded-lg hover:bg-red-100 active:scale-95 transition">Xóa</button>
                        <button onclick="submitConnectMessenger()" id="btn-connect-mess" class="flex-1 bg-blue-600 text-white font-bold py-2.5 rounded-lg hover:bg-blue-700 active:scale-95 transition">Kết nối</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal Kết nối Zalo -->
        <div id="zalo-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm transition-opacity">
            <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl transform transition-all mx-4">
                <div class="flex justify-between items-center mb-5">
                    <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <i class="fas fa-comment text-blue-500"></i> Kết nối Zalo
                    </h3>
                    <button onclick="closeZaloModal()" class="text-slate-400 hover:text-slate-700 transition"><i class="fas fa-times"></i></button>
                </div>
                <div class="space-y-4 text-sm text-slate-600">
                    <p><strong>Bước 1:</strong> <a href="http://zalo.me/2964654108509538584?src=qr" target="_blank" class="text-blue-600 font-bold hover:underline">Nhấn vào đây</a> để mở bot trên Zalo hoặc dùng Zalo quét mã bên dưới:</p>
                    <div class="flex justify-center my-3">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=http://zalo.me/2964654108509538584?src=qr" alt="Zalo QR Code" class="w-32 h-32 border border-slate-200 p-1 rounded-lg shadow-sm">
                    </div>
                    <p><strong>Bước 2:</strong> Gửi tin nhắn <code class="bg-slate-100 px-1.5 py-0.5 rounded text-pink-600 font-mono">/getchatid</code> cho bot trên Zalo để nhận Chat ID của bạn.</p>
                    <p><strong>Bước 3:</strong> Nhập Chat ID của bạn vào ô bên dưới:</p>
                    <div>
                        <input type="text" id="zalo-chatid" class="w-full px-4 py-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300" placeholder="Nhập Chat ID của bạn">
                    </div>
                    <p class="text-xs text-slate-500 italic mt-2"><i class="fas fa-info-circle"></i> Khi bạn có email mới, chúng tôi sẽ chuyển thành tin nhắn gửi cho bạn.</p>
                    
                    <div class="pt-2 flex gap-3">
                        <button onclick="deleteZaloConnection()" id="btn-delete-zalo" class="hidden w-1/3 bg-red-50 text-red-600 font-bold py-2.5 rounded-lg hover:bg-red-100 active:scale-95 transition">Xóa</button>
                        <button onclick="submitConnectZalo()" id="btn-connect-zalo" class="flex-1 bg-blue-500 text-white font-bold py-2.5 rounded-lg hover:bg-blue-600 active:scale-95 transition">Kết nối</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let lastEmailCount = 0;
        const currentToken = localStorage.getItem('auth_token');

        function toast(title, icon = 'success') {
            Swal.fire({ title, icon, toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, timerProgressBar: true });
        }

        function togglePassword() {
            const pwd = document.getElementById('password');
            const icon = document.getElementById('toggleIcon');
            const isPwd = pwd.type === 'password';
            pwd.type = isPwd ? 'text' : 'password';
            icon.classList.replace(isPwd ? 'fa-eye' : 'fa-eye-slash', isPwd ? 'fa-eye-slash' : 'fa-eye');
        }

        async function handleAuth() {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            if(!username || !password) return toast('Vui lòng điền đủ thông tin', 'warning');
            const email = username + '@snres.net';

            const btn = document.getElementById('auth-btn');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (data.token) {
                    localStorage.setItem('auth_token', data.token);
                    localStorage.setItem('user_email', email);
                    location.reload();
                } else {
                    toast(data.error || 'Thất bại', 'error');
                }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Đăng nhập'; }
        }

        async function loadEmails(isSilent = false) {
            const list = document.getElementById('email-list');
            if (!isSilent) list.innerHTML = '<div class="p-10 text-center"><i class="fas fa-circle-notch fa-spin text-blue-600"></i></div>';
            
            try {
                const res = await fetch('/api/emails', { headers: { 'Authorization': 'Bearer ' + currentToken } });
                if (res.status === 401) return logout();
                const response = await res.json();
                const emails = response.data?.emails || [];

                if (isSilent && emails.length > lastEmailCount) toast('🚀 Có thư mới!', 'info');
                lastEmailCount = emails.length;

                list.innerHTML = emails.length ? '' : '<div class="p-10 text-center text-slate-400 text-xs font-bold">HỘP THƯ TRỐNG</div>';
                emails.forEach(mail => {
                    const div = document.createElement('div');
                    div.className = 'email-item p-4 border-b cursor-pointer hover:bg-slate-50 transition';
                    div.id = 'mail-' + mail.id;
                    const avatarChar = mail.from.replace(/^["' <]+/, '').charAt(0).toUpperCase();
                    div.innerHTML = \`
                        <div class="flex items-start gap-3">
                            <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold flex-shrink-0 mt-0.5">\${avatarChar}</div>
                            <div class="min-w-0 flex-1">
                                <div class="flex justify-between items-center mb-1">
                                    <span class="text-sm font-bold text-slate-800 truncate pr-4">\${mail.from.split('<')[0].replace(/^["' ]+|["' ]+$/g, '')}</span>
                                    <span class="text-[10px] text-slate-400 font-bold whitespace-nowrap">\${mail.date.split(',')[0]}</span>
                                </div>
                                <div class="text-xs font-medium text-blue-600 truncate">\${mail.subject}</div>
                            </div>
                        </div>
                    \`;
                    div.onclick = () => viewEmail(mail);
                    list.appendChild(div);
                });
            } catch (e) {}
        }

        async function viewEmail(mail) {
            // UI Update
            document.querySelectorAll('.email-item').forEach(el => el.classList.remove('active'));
            document.getElementById('mail-' + mail.id)?.classList.add('active');
            document.getElementById('viewer-container').classList.remove('translate-x-full');
            document.getElementById('viewer-placeholder').classList.remove('md:flex');
            document.getElementById('viewer-placeholder').classList.add('hidden');
            document.getElementById('viewer-content').classList.remove('hidden');
            
            document.getElementById('view-subject').innerText = mail.subject;
            document.getElementById('view-from').innerText = mail.from;
            document.getElementById('view-date').innerText = mail.date;
            document.getElementById('view-avatar').innerText = mail.from.replace(/^["' <]+/, '').charAt(0).toUpperCase();

            // Iframe Handling: Xóa nội dung cũ trước khi tải mới
            const viewer = document.getElementById('email-viewer');
            const doc = viewer.contentDocument || viewer.contentWindow.document;
            doc.open();
            doc.write('<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i>&nbsp;Đang tải...</div>');
            doc.close();

            try {
                // Changed from 'token' to 'id'
                const response = await fetch('/html?id=' + mail.id);
                const htmlContent = await response.text();
                doc.open();
                doc.write(htmlContent);
                const style = doc.createElement('style');
                style.textContent = 'body{margin:0;padding:20px;font-family:sans-serif;line-height:1.6;}img{max-width:100%;height:auto;}table{width:100%!important;}';
                doc.head.appendChild(style);
                doc.close();
            } catch (e) {
                doc.open(); doc.write('<p style="color:red;padding:20px;">Lỗi tải thư.</p>'); doc.close();
            }
        }

        function closeEmail() { document.getElementById('viewer-container').classList.add('translate-x-full'); }
        function logout() { localStorage.clear(); location.reload(); }

        function toggleUserMenu() {
            document.getElementById('user-dropdown').classList.toggle('hidden');
        }

        // Đóng menu khi người dùng bấm ra ngoài khoảng trống
        document.addEventListener('click', (e) => {
            const container = document.getElementById('user-menu-container');
            const dropdown = document.getElementById('user-dropdown');
            if (container && !container.contains(e.target) && !dropdown.classList.contains('hidden')) {
                dropdown.classList.add('hidden');
            }
        });

        // Logic đổi mật khẩu
        function changePassword() {
            document.getElementById('user-dropdown').classList.add('hidden');
            document.getElementById('password-modal').classList.remove('hidden');
            document.getElementById('old-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
        }

        function closePasswordModal() {
            document.getElementById('password-modal').classList.add('hidden');
        }

        async function submitChangePassword() {
            const oldPwd = document.getElementById('old-password').value;
            const newPwd = document.getElementById('new-password').value;
            const confirmPwd = document.getElementById('confirm-password').value;

            if(!oldPwd || !newPwd || !confirmPwd) return toast('Vui lòng điền đủ thông tin', 'warning');
            if(newPwd !== confirmPwd) return toast('Mật khẩu mới không khớp', 'error');
            if(newPwd.length < 6) return toast('Mật khẩu mới nên có ít nhất 6 ký tự', 'warning');

            const btn = document.getElementById('btn-change-pwd');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + currentToken },
                    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
                });
                const data = await res.json();
                
                if (data.status === 'success') { toast('Đổi mật khẩu thành công!'); closePasswordModal(); }
                else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Cập nhật mật khẩu'; }
        }

        // Logic kết nối Telegram
        async function connectTelegram() {
            document.getElementById('user-dropdown').classList.add('hidden');
            const modal = document.getElementById('telegram-modal');
            const input = document.getElementById('telegram-chatid');
            const btnDelete = document.getElementById('btn-delete-tele');
            const btnConnect = document.getElementById('btn-connect-tele');
            
            input.value = '';
            input.placeholder = 'Đang kiểm tra...';
            modal.classList.remove('hidden');

            try {
                const res = await fetch('/api/connect-telegram', { headers: { 'Authorization': 'Bearer ' + currentToken } });
                const data = await res.json();
                input.placeholder = 'Nhập Chat ID của bạn';
                if (data.chatId) {
                    input.value = data.chatId;
                    btnDelete.classList.remove('hidden');
                    btnConnect.innerText = 'Cập nhật';
                } else {
                    btnDelete.classList.add('hidden');
                    btnConnect.innerText = 'Kết nối Telegram';
                }
            } catch (e) {}
        }

        function closeTelegramModal() {
            document.getElementById('telegram-modal').classList.add('hidden');
        }

        async function submitConnectTelegram() {
            const chatId = document.getElementById('telegram-chatid').value.trim();
            if(!chatId) return toast('Vui lòng nhập Chat ID', 'warning');

            const btn = document.getElementById('btn-connect-tele');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-telegram', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + currentToken },
                    body: JSON.stringify({ chatId })
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Kết nối Telegram thành công!');
                    closeTelegramModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Kết nối Telegram'; }
        }

        async function deleteTelegramConnection() {
            const btn = document.getElementById('btn-delete-tele');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-telegram', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Đã xóa kết nối Telegram!');
                    closeTelegramModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Xóa'; }
        }

        // Logic kết nối Messenger
        async function connectMessenger() {
            document.getElementById('user-dropdown').classList.add('hidden');
            const modal = document.getElementById('messenger-modal');
            const input = document.getElementById('messenger-apikey');
            const btnDelete = document.getElementById('btn-delete-mess');
            const btnConnect = document.getElementById('btn-connect-mess');
            
            input.value = '';
            input.placeholder = 'Đang kiểm tra...';
            modal.classList.remove('hidden');

            try {
                const res = await fetch('/api/connect-messenger', { headers: { 'Authorization': 'Bearer ' + currentToken } });
                const data = await res.json();
                input.placeholder = 'Nhập API Key của bạn';
                if (data.apiKey) {
                    input.value = data.apiKey;
                    btnDelete.classList.remove('hidden');
                    btnConnect.innerText = 'Cập nhật';
                } else {
                    btnDelete.classList.add('hidden');
                    btnConnect.innerText = 'Kết nối Messenger';
                }
            } catch (e) {}
        }

        function closeMessengerModal() {
            document.getElementById('messenger-modal').classList.add('hidden');
        }

        async function submitConnectMessenger() {
            const apiKey = document.getElementById('messenger-apikey').value.trim();
            if(!apiKey) return toast('Vui lòng nhập API Key', 'warning');

            const btn = document.getElementById('btn-connect-mess');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-messenger', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + currentToken },
                    body: JSON.stringify({ apiKey })
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Kết nối Messenger thành công!');
                    closeMessengerModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Kết nối Messenger'; }
        }

        async function deleteMessengerConnection() {
            const btn = document.getElementById('btn-delete-mess');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-messenger', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Đã xóa kết nối Messenger!');
                    closeMessengerModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Xóa'; }
        }

        // Logic kết nối Zalo
        async function connectZalo() {
            document.getElementById('user-dropdown').classList.add('hidden');
            const modal = document.getElementById('zalo-modal');
            const input = document.getElementById('zalo-chatid');
            const btnDelete = document.getElementById('btn-delete-zalo');
            const btnConnect = document.getElementById('btn-connect-zalo');
            
            input.value = '';
            input.placeholder = 'Đang kiểm tra...';
            modal.classList.remove('hidden');

            try {
                const res = await fetch('/api/connect-zalo', { headers: { 'Authorization': 'Bearer ' + currentToken } });
                const data = await res.json();
                input.placeholder = 'Nhập Chat ID của bạn';
                if (data.chatId) {
                    input.value = data.chatId;
                    btnDelete.classList.remove('hidden');
                    btnConnect.innerText = 'Cập nhật';
                } else {
                    btnDelete.classList.add('hidden');
                    btnConnect.innerText = 'Kết nối Zalo';
                }
            } catch (e) {}
        }

        function closeZaloModal() {
            document.getElementById('zalo-modal').classList.add('hidden');
        }

        async function submitConnectZalo() {
            const chatId = document.getElementById('zalo-chatid').value.trim();
            if(!chatId) return toast('Vui lòng nhập Chat ID', 'warning');

            const btn = document.getElementById('btn-connect-zalo');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-zalo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + currentToken },
                    body: JSON.stringify({ chatId })
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Kết nối Zalo thành công!');
                    closeZaloModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Kết nối Zalo'; }
        }

        async function deleteZaloConnection() {
            const btn = document.getElementById('btn-delete-zalo');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            try {
                const res = await fetch('/api/connect-zalo', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + currentToken }
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    toast('Đã xóa kết nối Zalo!');
                    closeZaloModal();
                } else { toast(data.error || 'Có lỗi xảy ra', 'error'); }
            } catch (e) { toast('Lỗi kết nối', 'error'); }
            finally { btn.disabled = false; btn.innerText = 'Xóa'; }
        }

        if (currentToken) {
            document.getElementById('auth-section').classList.add('hidden');
            document.getElementById('dashboard-section').classList.remove('hidden');
            document.getElementById('user-display').innerText = localStorage.getItem('user_email');
            loadEmails();
            setInterval(() => loadEmails(true), 30000);
        }
    </script>
</body>
</html>
  `;
}