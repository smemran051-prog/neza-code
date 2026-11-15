'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'deep_data_recovery',
  description: 'Recover deleted files from a specific drive or SD card using PhotoRec engine.',
  tags: ['recover', 'data recovery', 'undelete', 'photorec', 'restore files', 'sd card', 'drive'],
  risk: 'RISKY', // যেহেতু এটি ডিস্কের র-ডেটা রিড করবে
  parameters: {
    type: 'object',
    properties: {
      drive_letter: { 
        type: 'string', 
        description: 'Drive letter to scan (e.g., E, F, G).' 
      }
    },
    required: ['drive_letter'],
  },
  async execute(args, ctx) {
    const drive = String(args.drive_letter || '').replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (!drive) return { error: 'invalid_drive_letter' };

    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const photoRecPath = path.join(root, 'bin', 'photorec_win.exe');
    
    if (!fs.existsSync(photoRecPath)) {
      return { error: 'photorec_engine_not_found_in_bin_folder' };
    }

    // রিকভার করা ডেটা যেখানে সেভ হবে
    const recoveryDir = path.join(root, 'work', 'recovered_data', `Drive_${drive}_${Date.now()}`);
    fs.mkdirSync(recoveryDir, { recursive: true });

    return new Promise((resolve) => {
      // PhotoRec কমান্ড লাইন আর্গুমেন্ট (সাইলেন্টলি রান করার জন্য)
      // /d = destination, /cmd = command (drive search)
      const photorec = spawn(photoRecPath, ['/log', '/d', recoveryDir, '/cmd', `${drive}:`, 'search'], {
        windowsHide: true, // ইউজারের সামনে কোনো CMD উইন্ডো ওপেন হবে না
      });

      photorec.on('close', (code) => {
        if (code === 0) {
          resolve({ 
            success: true, 
            message: `Recovery completed. Files saved to: ${recoveryDir}`,
            status: 'Check the folder for recovered files.' 
          });
        } else {
          resolve({ error: `recovery_process_exited_with_code_${code}` });
        }
      });

      photorec.on('error', (err) => {
        resolve({ error: `failed_to_start_engine: ${err.message}` });
      });
    });
  },
};