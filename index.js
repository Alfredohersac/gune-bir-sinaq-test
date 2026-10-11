const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const publicDir = path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir, { index: false }));
app.use('/uploads', express.static(path.join(__dirname, 'backend', 'uploads')));

app.use('/api/auth', require('./backend/routes/auth'));
app.use('/api/exams', require('./backend/routes/exams'));
app.use('/api/results', require('./backend/routes/results'));
app.use('/api/base', require('./backend/routes/base'));

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'landing.html')));
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'pages', 'admin.html')));
app.get('/user', (req, res) => res.sendFile(path.join(publicDir, 'pages', 'user.html')));

module.exports = app;
