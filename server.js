const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory');
}

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only .txt files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Email transporter configuration
let transporter = null;

if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    }
  });
} else {
  console.log('Email configuration skipped - credentials not found');
}

// Debug: Check if environment variables are loaded
console.log('Environment variables check:');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? '✓ Found' : '✗ Missing');
console.log('EMAIL_APP_PASSWORD:', process.env.EMAIL_APP_PASSWORD ? '✓ Found' : '✗ Missing');
console.log('HUGGING_FACE_TOKEN:', process.env.HUGGING_FACE_TOKEN ? '✓ Found' : '✗ Missing');

// Test email configuration on startup (only if credentials are available)
if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
  transporter.verify((error, success) => {
    if (error) {
      console.log('Email configuration error:', error.message);
      console.log('This won\'t prevent the server from running, but email features won\'t work.');
    } else {
      console.log('Email server is ready to send messages');
    }
  });
} else {
  console.log('Email credentials missing - email features will be disabled');
}

// FIXED Hugging Face API integration
async function summarizeWithHuggingFace(text, customPrompt = '') {
  try {
    console.log('Calling Hugging Face API...');
    console.log('Token length:', process.env.HUGGING_FACE_TOKEN?.length);
    console.log('Token starts with hf_:', process.env.HUGGING_FACE_TOKEN?.startsWith('hf_'));
    
    // Truncate text if it's too long (BART model has input limits)
    let processedText = text;
    if (text.length > 4000) {
      processedText = text.substring(0, 4000);
      console.log('Text truncated to 4000 characters');
    }
    
    const response = await fetch('https://api-inference.huggingface.co/models/facebook/bart-large-cnn', {
      headers: {
        'Authorization': `Bearer ${process.env.HUGGING_FACE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        inputs: processedText,
        parameters: {
          max_length: 500,
          min_length: 50,
          do_sample: false,
        }
      }),
    });

    console.log('API Response Status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Hugging Face API error: ${response.status} - ${errorText}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('Hugging Face API response:', result);
    
    let summary = result[0]?.summary_text || result[0]?.generated_text || '';

    if (!summary) {
      throw new Error('No summary generated from API');
    }

    // Apply custom prompt formatting
    if (customPrompt.toLowerCase().includes('bullet') || customPrompt.toLowerCase().includes('points')) {
      const sentences = summary.split('.').filter(s => s.trim());
      summary = "Key Points:\n" + sentences.map((sentence) => `• ${sentence.trim()}.`).join('\n');
    } else if (customPrompt.toLowerCase().includes('action')) {
      const sentences = summary.split('.').filter(s => s.trim());
      summary = "Action Items:\n" + sentences.map((sentence, index) => `${index + 1}. ${sentence.trim()}.`).join('\n');
    } else if (customPrompt.toLowerCase().includes('executive')) {
      summary = `Executive Summary:\n\n${summary}`;
    }

    console.log('Final summary generated successfully');
    return summary;
  } catch (error) {
    console.error('Hugging Face API error:', error);
    throw error;
  }
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

// Test route to verify server is working
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Backend server is working!',
    env: {
      hasHuggingFaceToken: !!process.env.HUGGING_FACE_TOKEN,
      hasEmailUser: !!process.env.EMAIL_USER,
      hasEmailPassword: !!process.env.EMAIL_APP_PASSWORD,
      port: PORT
    }
  });
});

// Summarize text
app.post('/api/summarize', async (req, res) => {
  try {
    console.log('Received summarize request');
    const { text, customPrompt } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: 'Text is required' 
      });
    }

    console.log('Text length:', text.length);
    console.log('Custom prompt:', customPrompt);

    let summary;
    let fallback = false;

    try {
      summary = await summarizeWithHuggingFace(text, customPrompt);
    } catch (error) {
      console.log('Hugging Face failed, using fallback...');
      summary = createFallbackSummary(text, customPrompt);
      fallback = true;
    }
    
    res.json({ 
      success: true, 
      summary: summary,
      originalLength: text.length,
      summaryLength: summary.length,
      fallback: fallback
    });
  } catch (error) {
    console.error('Summarization error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate summary',
      details: error.message
    });
  }
});

// Fallback summarization function
function createFallbackSummary(text, customPrompt = '') {
  console.log('Creating fallback summary...');
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const keyPoints = sentences.slice(0, Math.min(5, sentences.length));
  
  let summary = '';
  
  if (customPrompt.toLowerCase().includes('bullet') || customPrompt.toLowerCase().includes('points')) {
    summary = "Key Points:\n" + keyPoints.map((sentence, index) => `• ${sentence.trim()}.`).join('\n');
  } else if (customPrompt.toLowerCase().includes('action')) {
    summary = "Action Items:\n" + keyPoints.map((sentence, index) => `${index + 1}. ${sentence.trim()}.`).join('\n');
  } else if (customPrompt.toLowerCase().includes('executive')) {
    summary = `Executive Summary:\n\n${keyPoints.join('. ')}.`;
  } else {
    summary = keyPoints.join('. ') + '.';
  }
  
  return summary;
}

// Upload file endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: 'No file uploaded' 
      });
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    res.json({ 
      success: true, 
      content: fileContent,
      filename: req.file.originalname 
    });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ 
      success: false,
      error: 'File upload failed',
      details: error.message
    });
  }
});

// Send email endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    console.log('Received email request');
    
    if (!transporter) {
      return res.status(500).json({ 
        success: false,
        error: 'Email service not configured. Please check your EMAIL_USER and EMAIL_APP_PASSWORD in .env file.'
      });
    }
    
    const { to, subject, body } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Recipients are required' 
      });
    }

    if (!body || body.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: 'Email body is required' 
      });
    }

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: to.join(','),
      subject: subject || 'Meeting Summary',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px;">
            Meeting Summary
          </h2>
          <div style="white-space: pre-wrap; line-height: 1.6; color: #555; background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
            ${body.replace(/\n/g, '<br>')}
          </div>
          <p style="color: #888; font-size: 12px; margin-top: 30px;">
            This summary was generated and sent via AI Meeting Notes Summarizer
          </p>
        </div>
      `
    };

    console.log('Sending email to:', to);
    await transporter.sendMail(mailOptions);
    
    res.json({ 
      success: true, 
      message: 'Email sent successfully',
      recipients: to.length 
    });
  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to send email',
      details: error.message 
    });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist', 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error middleware:', err.stack);
  res.status(500).json({ 
    success: false,
    error: 'Something went wrong!',
    details: err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found' 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Server URL: http://localhost:${PORT}`);
  console.log('Available routes:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/test');
  console.log('  POST /api/summarize');
  console.log('  POST /api/upload');
  console.log('  POST /api/send-email');
});