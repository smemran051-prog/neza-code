const http = require('http');
const crypto = require('crypto');

const PORT = 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Create a raw WebSocket handshake request using standard HTTP
const req = http.request({
    port: PORT,
    host: '127.0.0.1',
    headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
    }
});

req.on('upgrade', (res, socket, upgradeHead) => {
    console.log("✅ JARVIS Bridge Connected successfully!");
    
    // Prepare JSON payload
    const payload = JSON.stringify({ action: 'list_dir', payload: { path: '00_ENGINE' } });
    const payloadBuffer = Buffer.from(payload, 'utf8');
    
    // WebSocket protocol requires client messages to be masked
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.alloc(payloadBuffer.length);
    for (let i = 0; i < payloadBuffer.length; i++) {
        maskedPayload[i] = payloadBuffer[i] ^ mask[i % 4];
    }
    
    // Build frame header
    let header;
    if (payloadBuffer.length < 126) {
        header = Buffer.from([0x81, 0x80 | payloadBuffer.length]);
    } else if (payloadBuffer.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payloadBuffer.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
    }
    
    const frame = Buffer.concat([header, mask, maskedPayload]);
    socket.write(frame);

    // Listen for JARVIS Reply
    socket.on('data', (data) => {
        if (data.length < 2) return;
        let offset = 2;
        let payloadLength = data[1] & 0x7f;
        if (payloadLength === 126) { payloadLength = data.readUInt16BE(2); offset += 2; }
        else if (payloadLength === 127) { payloadLength = Number(data.readBigUInt64BE(2)); offset += 8; }
        
        const message = data.slice(offset, offset + payloadLength).toString('utf8');
        try {
            const parsed = JSON.parse(message);
            console.log("\n📩 JARVIS Reply:");
            console.log(JSON.stringify(parsed, null, 2));
        } catch(e) {
            console.log("\nRaw message:", message);
        }
        process.exit(0); // Exit after receiving response
    });
});

req.on('error', (err) => {
    console.error("\n❌ Connection Failed:", err.message);
    console.log("Make sure JARVIS is running and port 8080 is not blocked.");
    process.exit(1);
});

req.end();