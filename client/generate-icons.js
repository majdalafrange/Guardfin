#!/usr/bin/env node
/**
 * Guardfin Icon Generator
 * 
 * This script generates PWA icons. Run it with:
 * node generate-icons.js
 * 
 * Requires: npm install canvas
 * Or just open generate-icons.html in a browser to download icons.
 */

const fs = require('fs');
const path = require('path');

// Try to use canvas, fall back to creating placeholder files
async function generateIcons() {
    const sizes = [16, 32, 72, 96, 128, 144, 152, 192, 384, 512];
    const iconsDir = path.join(__dirname, 'icons');
    
    // Ensure icons directory exists
    if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
    }

    try {
        // Try to use canvas package
        const { createCanvas } = require('canvas');
        
        for (const size of sizes) {
            const canvas = createCanvas(size, size);
            const ctx = canvas.getContext('2d');
            
            // Background gradient (simplified for canvas)
            ctx.fillStyle = '#6366f1';
            
            // Rounded rectangle
            const radius = size * 0.2;
            ctx.beginPath();
            ctx.roundRect(0, 0, size, size, radius);
            ctx.fill();
            
            // White shield shape
            ctx.fillStyle = 'white';
            const centerX = size / 2;
            const centerY = size / 2;
            const iconSize = size * 0.5;
            
            ctx.beginPath();
            const shieldTop = centerY - iconSize * 0.45;
            const shieldBottom = centerY + iconSize * 0.45;
            const shieldLeft = centerX - iconSize * 0.4;
            const shieldRight = centerX + iconSize * 0.4;
            
            ctx.moveTo(centerX, shieldTop);
            ctx.lineTo(shieldRight, shieldTop + iconSize * 0.15);
            ctx.lineTo(shieldRight, centerY);
            ctx.quadraticCurveTo(shieldRight, shieldBottom - iconSize * 0.1, centerX, shieldBottom);
            ctx.quadraticCurveTo(shieldLeft, shieldBottom - iconSize * 0.1, shieldLeft, centerY);
            ctx.lineTo(shieldLeft, shieldTop + iconSize * 0.15);
            ctx.closePath();
            ctx.fill();
            
            // Dollar sign
            ctx.fillStyle = '#6366f1';
            ctx.font = `bold ${size * 0.25}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('$', centerX, centerY + size * 0.02);
            
            // Save to file
            const buffer = canvas.toBuffer('image/png');
            fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), buffer);
            console.log(`✅ Created icon-${size}.png`);
        }
        
        console.log('\n✅ All icons generated successfully!');
        
    } catch (err) {
        console.log('⚠️  Canvas package not installed. Creating placeholder icons...');
        console.log('   For proper icons, either:');
        console.log('   1. Run: npm install canvas && node generate-icons.js');
        console.log('   2. Open generate-icons.html in a browser\n');
        
        // Create simple 1x1 purple PNG as placeholder
        // This is a minimal valid PNG file
        const purplePng = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
            0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
            0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0xF8, 0x0F,
            0x00, 0x00, 0x01, 0x01, 0x00, 0x05, 0x18, 0xD8,
            0x4D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
            0x44, 0xAE, 0x42, 0x60, 0x82
        ]);
        
        for (const size of sizes) {
            fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), purplePng);
            console.log(`📝 Created placeholder icon-${size}.png`);
        }
        
        console.log('\n⚠️  Placeholder icons created. For proper icons, open generate-icons.html in a browser.');
    }
}

generateIcons();
