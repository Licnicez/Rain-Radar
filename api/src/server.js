import express from 'express';
import cors from 'cors';
import { analyzeRouteWeather } from './services/routeWeather.service.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Rain Radar API is running!' });
});

// Endpoint เช็กฝนเส้นทาง รองรับเวลาออกเดินทางล่วงหน้า
app.post('/api/analyze-route', async (req, res) => {
  try {
    const { origin, destination, sampleIntervalKm, departureOffsetMin } = req.body;

    if (!origin?.lat || !origin?.lon || !destination?.lat || !destination?.lon) {
      return res.status(400).json({
        status: 'error',
        message: 'กรุณาระบุพิกัด origin และ destination ให้ครบถ้วน',
      });
    }

    const result = await analyzeRouteWeather({
      origin,
      destination,
      sampleIntervalKm: sampleIntervalKm || 4,
      departureOffsetMin: Number(departureOffsetMin) || 0,
    });

    res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('Error analyzing route:', error.message);
    const status = error.response?.status || 500;
    let message = error.message;
    if (status === 429) {
      message = 'บริการสภาพอากาศ (Open-Meteo) ถูกเรียกใช้งานถี่เกินไปชั่วคราว กรุณารอประมาณ 5-10 วินาทีแล้วลองใหม่อีกครั้ง';
    }
    res.status(status).json({ status: 'error', message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});