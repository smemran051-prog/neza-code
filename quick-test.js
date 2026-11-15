const http = require('http');
const crypto = require('crypto');
const PORT = 8080;

const req = http.request({
    port: PORT, host: '127.0.0.1',
    headers: {
        'Connection': 'Upgrade', 'Upgrade': 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
    }
});

req.on('upgrade', (res, socket) => {
    console.log("🔗 Connected to JARVIS Bridge!");
    
    function sendCommand(payload) {
        const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
        const mask = crypto.randomBytes(4);
        const maskedPayload = Buffer.alloc(payloadBuffer.length);
        for (let i = 0; i < payloadBuffer.length; i++) maskedPayload[i] = payloadBuffer[i] ^ mask[i % 4];
        
        const header = Buffer.from([0x81, 0x80 | payloadBuffer.length]);
        socket.write(Buffer.concat([header, mask, maskedPayload]));
    }

    // 1. Tell JARVIS to create a file
    console.log("📝 Creating a test file in your project...");
    sendCommand({
        action: 'write_file',
        payload: {
            path: 'JARVIS_TEST_SUCCESS.txt',
            content: 'Congratulations! The Agentic Bridge is 100% operational. JARVIS can now be controlled by external AI.'
        }
    });

    let step = 1;
    socket.on('data', (data) => {
        let offset = 2;
        let payloadLength = data[1] & 0x7f;
        if (payloadLength === 126) { payloadLength = data.readUInt16BE(2); offset += 2; }
        
        const message = data.slice(offset, offset + payloadLength).toString('utf8');
        
        if (step === 1) {
            console.log("✅ File created successfully!");
            console.log("🚀 Now telling JARVIS to open Notepad...");
            // 2. Tell JARVIS to open Notepad and show the file
            sendCommand({
                action: 'run_command',
                payload: { command: 'notepad JARVIS_TEST_SUCCESS.txt' }
            });
            step = 2;
        } else if (step === 2) {
            console.log("🎉 BOOM! Notepad opened automatically. Test Complete!");
            process.exit(0);
        }
    });
});

req.on('error', (err) => {
    console.error("❌ Connection Failed. Make sure JARVIS is running.");
    process.exit(1);
});
req.end();