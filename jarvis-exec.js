const http = require('http');
const crypto = require('crypto');

const action = process.argv[2];
const payloadStr = process.argv[3] || '{}';

if (!action) {
    console.log("Usage: node jarvis-exec.js <action> '<json_payload>'");
    console.log("Example: node jarvis-exec.js run_command '{\"command\":\"dir\"}'");
    process.exit(1);
}

let payload;
try {
    payload = JSON.parse(payloadStr);
} catch (e) {
    console.error("❌ Invalid JSON payload format.");
    process.exit(1);
}

const req = http.request({
    port: 8080, host: '127.0.0.1',
    headers: {
        'Connection': 'Upgrade', 'Upgrade': 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
    }
});

req.on('upgrade', (res, socket) => {
    const payloadBuffer = Buffer.from(JSON.stringify({ action, payload }), 'utf8');
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.alloc(payloadBuffer.length);
    for (let i = 0; i < payloadBuffer.length; i++) maskedPayload[i] = payloadBuffer[i] ^ mask[i % 4];
    
    const header = Buffer.from([0x81, 0x80 | payloadBuffer.length]);
    socket.write(Buffer.concat([header, mask, maskedPayload]));

    socket.on('data', (data) => {
        let offset = 2;
        let payloadLength = data[1] & 0x7f;
        if (payloadLength === 126) { payloadLength = data.readUInt16BE(2); offset += 2; }
        
        const message = data.slice(offset, offset + payloadLength).toString('utf8');
        try {
            const parsed = JSON.parse(message);
            console.log("\n📩 JARVIS Reply:");
            console.log(JSON.stringify(parsed, null, 2));
        } catch(e) {
            console.log(message);
        }
        process.exit(0);
    });
});

req.on('error', () => {
    console.error("❌ Connection Failed. Make sure JARVIS is running in another terminal.");
    process.exit(1);
});
req.end();