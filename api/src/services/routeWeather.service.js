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

// ดึงสภาพอากาศแบบ Batch (ส่งหลายพิกัดใน 1 คำขอ เพื่อป้องกัน HTTP 429 Too Many Requests)
async function fetchBatchWeather(checkpoints, currentHour) {
  const batchSize = 30; // Open-Meteo รองรับ comma-separated coordinates ได้สูงสุดถึง 100 จุด
  const allResults = [];

  for (let i = 0; i < checkpoints.length; i += batchSize) {
    const chunk = checkpoints.slice(i, i + batchSize);
    const lats = chunk.map((pt) => pt.lat.toFixed(4)).join(',');
    const lons = chunk.map((pt) => pt.lon.toFixed(4)).join(',');

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=precipitation_probability,rain&forecast_days=1&timezone=auto`;

    // เพิ่ม retry เล็กน้อยหากติด network หรือ 429
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
      const wData = weatherList[index] || weatherList[0];
      const hourly = wData?.hourly || {};

      const rainProb = hourly.precipitation_probability ? hourly.precipitation_probability[currentHour] ?? 0 : 0;
      const rainAmount = hourly.rain ? hourly.rain[currentHour] ?? 0 : 0;

      let status = 'SAFE';
      if (rainProb >= 50 || rainAmount >= 1.0) {
        status = 'DANGER';
      } else if (rainProb >= 25 || rainAmount > 0) {
        status = 'WARNING';
      }

      allResults.push({
        id: allResults.length + 1,
        lat: pt.lat,
        lon: pt.lon,
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

export async function analyzeRouteWeather({ origin, destination, sampleIntervalKm = 4 }) {
  // 1. ดึงเส้นทางจาก OSRM
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson`;
  const routeRes = await axios.get(osrmUrl, { timeout: 8000 });
  const route = routeRes.data.routes[0];

  if (!route) {
    throw new Error('ไม่พบเส้นทาง');
  }

  const coordinates = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const checkpoints = sampleRoutePoints(coordinates, sampleIntervalKm);

  // 2. ดึงสภาพอากาศจาก Open-Meteo แบบ Batch (คำขอเดียวรวมทุกจุด ป้องกัน HTTP 429)
  const currentHour = new Date().getHours();
  const checkpointResults = await fetchBatchWeather(checkpoints, currentHour);

  // 3. สรุปภาพรวม
  const rainPoints = checkpointResults.filter((p) => p.status !== 'SAFE');
  const maxProb = Math.max(...checkpointResults.map((p) => p.rainProbability), 0);

  let overallStatus = 'SAFE';
  let recommendation = 'ถนนแห้ง ปลอดภัยตลอดสาย ขี่กลับได้สบายครับ';

  if (checkpointResults.some((p) => p.status === 'DANGER')) {
    overallStatus = 'DANGER';
    recommendation = 'เสี่ยงฝนตกหนักหรือมีฝนตามเส้นทาง แนะนำเตรียมชุดกันฝนหรือรอดูก่อนออกรถ';
  } else if (rainPoints.length > 0) {
    overallStatus = 'WARNING';
    recommendation = 'มีโอกาสเจอละอองฝนบางช่วง ขี่ด้วยความระมัดระวังถนนลื่น';
  }

  return {
    summary: {
      status: overallStatus,
      totalDistanceKm: (route.distance / 1000).toFixed(1),
      totalDurationMin: Math.round(route.duration / 60),
      totalCheckpoints: checkpointResults.length,
      rainPointsCount: rainPoints.length,
      maxRainProbability: maxProb,
      recommendation,
    },
    routeGeometry: route.geometry,
    checkpoints: checkpointResults,
  };
}