import axios from 'axios';

// คำนวณระยะห่างระหว่างจุด (Haversine formula - กิโลเมตร)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ซอยจุดพิกัดตามระยะห่าง (km)
function sampleRoutePoints(coordinates, intervalKm = 4) {
  if (!coordinates || coordinates.length === 0) return [];
  const sampled = [coordinates[0]];
  let lastPoint = coordinates[0];

  for (let i = 1; i < coordinates.length; i++) {
    const currentPoint = coordinates[i];
    const dist = calculateDistance(lastPoint.lat, lastPoint.lon, currentPoint.lat, currentPoint.lon);
    if (dist >= intervalKm) {
      sampled.push(currentPoint);
      lastPoint = currentPoint;
    }
  }

  const lastTarget = coordinates[coordinates.length - 1];
  if (sampled[sampled.length - 1] !== lastTarget) {
    sampled.push(lastTarget);
  }
  return sampled;
}

// ดึงสภาพอากาศแบบ Batch (ส่งหลายพิกัดใน 1 คำขอ พร้อมรองรับเวลาออกเดินทางล่วงหน้า)
async function fetchBatchWeather(checkpoints, departureDate, totalDurationMin) {
  const batchSize = 30;
  const allResults = [];

  for (let i = 0; i < checkpoints.length; i += batchSize) {
    const chunk = checkpoints.slice(i, i + batchSize);
    const lats = chunk.map((pt) => pt.lat.toFixed(4)).join(',');
    const lons = chunk.map((pt) => pt.lon.toFixed(4)).join(',');

    // forecast_days=2 เพื่อรองรับกรณีเดินทางข้ามวันหรือชั่วโมงล่วงหน้า
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=precipitation_probability,rain&forecast_days=2&timezone=auto`;

    let weatherRes;
    let attempts = 0;
    while (attempts < 2) {
      try {
        weatherRes = await axios.get(weatherUrl, { timeout: 8000 });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 2) throw err;
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    const weatherList = Array.isArray(weatherRes.data) ? weatherRes.data : [weatherRes.data];

    chunk.forEach((pt, index) => {
      const globalIndex = i + index;
      const wData = weatherList[index] || weatherList[0];
      const hourly = wData?.hourly || {};
      const timeArray = hourly.time || [];

      // คำนวณเวลาที่คาดว่าจะเดินทางไปถึงจุดตรวจนี้ (ETA at Checkpoint)
      const progressRatio = checkpoints.length > 1 ? globalIndex / (checkpoints.length - 1) : 0;
      const etaMinutes = progressRatio * totalDurationMin;
      const etaDate = new Date(departureDate.getTime() + etaMinutes * 60 * 1000);

      // แปลงเป็นฟอร์แมต ISO ชั่วโมงของ Open-Meteo เช่น "2026-10-01T21:00"
      const yr = etaDate.getFullYear();
      const mo = String(etaDate.getMonth() + 1).padStart(2, '0');
      const da = String(etaDate.getDate()).padStart(2, '0');
      const hr = String(etaDate.getHours()).padStart(2, '0');
      const matchHourStr = `${yr}-${mo}-${da}T${hr}:00`;

      // หา Index ของชั่วโมงนั้น
      let targetHourIdx = timeArray.indexOf(matchHourStr);
      if (targetHourIdx === -1) {
        targetHourIdx = Math.min(etaDate.getHours(), timeArray.length - 1);
      }

      const rainProb = hourly.precipitation_probability ? hourly.precipitation_probability[targetHourIdx] ?? 0 : 0;
      const rainAmount = hourly.rain ? hourly.rain[targetHourIdx] ?? 0 : 0;

      let status = 'SAFE';
      if (rainProb >= 50 || rainAmount >= 1.0) {
        status = 'DANGER';
      } else if (rainProb >= 25 || rainAmount > 0) {
        status = 'WARNING';
      }

      const etaFormatted = `${String(etaDate.getHours()).padStart(2, '0')}:${String(etaDate.getMinutes()).padStart(2, '0')}`;

      allResults.push({
        id: globalIndex + 1,
        lat: pt.lat,
        lon: pt.lon,
        etaTime: etaFormatted,
        rainProbability: rainProb,
        rainAmountMm: rainAmount,
        status,
      });
    });

    if (i + batchSize < checkpoints.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return allResults;
}

export async function analyzeRouteWeather({ origin, destination, sampleIntervalKm = 4, departureOffsetMin = 0 }) {
  // 1. ดึงเส้นทางจาก OSRM
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson`;
  const routeRes = await axios.get(osrmUrl, { timeout: 8000 });
  const route = routeRes.data.routes[0];

  if (!route) {
    throw new Error('ไม่พบเส้นทาง');
  }

  const coordinates = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const checkpoints = sampleRoutePoints(coordinates, sampleIntervalKm);
  const totalDurationMin = Math.round(route.duration / 60);

  // 2. คำนวณเวลาออกเดินทางจริง (Target Departure Time)
  const departureDate = new Date(Date.now() + departureOffsetMin * 60 * 1000);
  const departureTimeFormatted = `${String(departureDate.getHours()).padStart(2, '0')}:${String(departureDate.getMinutes()).padStart(2, '0')}`;

  // 3. ดึงสภาพอากาศจาก Open-Meteo ตามชั่วโมงที่เดินทางจริง
  const checkpointResults = await fetchBatchWeather(checkpoints, departureDate, totalDurationMin);

  // 4. สรุปภาพรวม
  const rainPoints = checkpointResults.filter((p) => p.status !== 'SAFE');
  const maxProb = Math.max(...checkpointResults.map((p) => p.rainProbability), 0);

  let overallStatus = 'SAFE';
  let recommendation = `ออกเดินทางเวลา ${departureTimeFormatted} น. ถนนแห้ง ปลอดภัยตลอดสาย ขี่กลับได้สบายครับ`;

  if (checkpointResults.some((p) => p.status === 'DANGER')) {
    overallStatus = 'DANGER';
    recommendation = `หากออกเวลา ${departureTimeFormatted} น. มีจุดเสี่ยงฝนตกหนักตามเส้นทาง แนะนำเลื่อนเวลาเดินทางหรือเตรียมชุดกันฝน`;
  } else if (rainPoints.length > 0) {
    overallStatus = 'WARNING';
    recommendation = `หากออกเวลา ${departureTimeFormatted} น. มีโอกาสเจอละอองฝนบางช่วง ขี่ด้วยความระมัดระวังถนนลื่น`;
  }

  return {
    summary: {
      status: overallStatus,
      departureTime: departureTimeFormatted,
      departureOffsetMin,
      totalDistanceKm: (route.distance / 1000).toFixed(1),
      totalDurationMin,
      totalCheckpoints: checkpointResults.length,
      rainPointsCount: rainPoints.length,
      maxRainProbability: maxProb,
      recommendation,
    },
    routeGeometry: route.geometry,
    checkpoints: checkpointResults,
  };
}