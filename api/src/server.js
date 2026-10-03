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

// Endpoint เช็กฝนเส้นทาง รองรับเวลาออกเดินทางล่วงหน้าและประเภทยานพาหนะ (มอเตอร์ไซค์/รถยนต์)
app.post('/api/analyze-route', async (req, res) => {
  try {
    const {
      origin,
      destination,
      sampleIntervalKm,
      departureOffsetMin,
      vehicleType = 'motorcycle',
      avoidHighways,
    } = req.body;

    if (!origin?.lat || !origin?.lon || !destination?.lat || !destination?.lon) {
      return res.status(400).json({
        status: 'error',
        message: 'กรุณาระบุพิกัด origin และ destination ให้ครบถ้วน',
      });
    }

    const isAvoid = avoidHighways !== undefined ? Boolean(avoidHighways) : vehicleType === 'motorcycle';

    const result = await analyzeRouteWeather({
      origin,
      destination,
      sampleIntervalKm: sampleIntervalKm || 4,
      departureOffsetMin: Number(departureOffsetMin) || 0,
      vehicleType,
      avoidHighways: isAvoid,
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

// Proxy endpoint สำหรับดึงข้อมูลพื้นที่น้ำท่วมจาก GISTDA (1 วัน หรือ 7 วัน)
app.get('/api/flood-data', async (req, res) => {
  try {
    const period = req.query.period === '7days' ? '7days' : '1day';
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    const url = `https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/${period}?limit=${limit}&offset=${offset}`;

    const gistdaRes = await fetch(url, {
      headers: {
        accept: 'application/json',
        'API-Key': 'iW8NtubTP0sqLeXaxMkvXZwvZJOIAnYJGf6ka1xc95LBz174Xu5dKwlrSKYx5j1b',
      },
    });

    if (!gistdaRes.ok) {
      return res.status(gistdaRes.status).json({ status: 'error', message: 'GISTDA API returned error' });
    }

    const data = await gistdaRes.json();
    res.json({ status: 'success', data });
  } catch (error) {
    console.error('Error fetching GISTDA flood data:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});