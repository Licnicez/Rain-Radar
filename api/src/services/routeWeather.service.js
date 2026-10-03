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

// จัดรูปแบบเวลาเดินทาง เช่น 25 นาที หรือ 1 ชม. 15 นาที
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} นาที`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hrs} ชม. ${rem} นาที` : `${hrs} ชม.`;
}

// ตรวจสอบว่าเส้นทางขึ้นทางด่วน/โทลล์เวย์หรือไม่ จาก OpenRouteService extras
function checkHasTollway(feature) {
  const tollSummary = feature?.properties?.extras?.tollways?.summary;
  if (Array.isArray(tollSummary)) {
    const tollSegment = tollSummary.find((s) => s.value === 1);
    if (tollSegment && tollSegment.distance > 100) {
      return {
        hasTollway: true,
        tollDistanceKm: (tollSegment.distance / 1000).toFixed(1),
        tollPercent: Math.round(tollSegment.amount),
      };
    }
  }
  return { hasTollway: false, tollDistanceKm: '0', tollPercent: 0 };
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

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=precipitation_probability,rain&forecast_days=2&timezone=auto`;

    let weatherRes;
    let attempts = 0;
    while (attempts < 2) {
      try {
        weatherRes = await axios.get(weatherUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'MotoRainRadar/1.0 (https://rain-radar.onrender.com)' },
        });
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

      const progressRatio = checkpoints.length > 1 ? globalIndex / (checkpoints.length - 1) : 0;
      const etaMinutes = progressRatio * totalDurationMin;
      const etaDate = new Date(departureDate.getTime() + etaMinutes * 60 * 1000);

      const yr = etaDate.getFullYear();
      const mo = String(etaDate.getMonth() + 1).padStart(2, '0');
      const da = String(etaDate.getDate()).padStart(2, '0');
      const hr = String(etaDate.getHours()).padStart(2, '0');
      const matchHourStr = `${yr}-${mo}-${da}T${hr}:00`;

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

const ORS_API_KEY =
  process.env.ORS_API_KEY ||
  'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImNhMjQ0ZWMyMmQ3ZTRmMDZiZmUxNmNiYWJiM2U4NDdhIiwiaCI6Im11cm11cjY0In0=';

// ดึงเส้นทางจาก OpenRouteService (ORS) พร้อมรองรับเลี่ยงทางด่วน/โทลล์เวย์/ทางหลวง และดึงทางเลือกหลายเส้นทาง (Alternative Routes)
async function fetchRoutesFromORS({
  origin,
  destination,
  avoidHighways = true,
  avoidTollways = true,
}) {
  const postUrl = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';

  const avoid_features = [];
  if (avoidTollways) avoid_features.push('tollways');
  if (avoidHighways) avoid_features.push('highways');

  const requestBody = {
    coordinates: [
      [Number(origin.lon), Number(origin.lat)],
      [Number(destination.lon), Number(destination.lat)],
    ],
    radiuses: [2000, 2000],
    alternative_routes: { target_count: 3, weight_factor: 1.6, share_factor: 0.8 },
    extra_info: ['tollways'],
  };

  if (avoid_features.length > 0) {
    requestBody.options = { avoid_features };
  }

  try {
    const res = await axios.post(postUrl, requestBody, {
      timeout: 9000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: ORS_API_KEY,
      },
    });

    const features = res.data?.features;
    if (features && features.length > 0) {
      return features.map((feature, i) => {
        const tollInfo = checkHasTollway(feature);
        return {
          id: i,
          coordinates: feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
          distanceMeters: feature.properties?.summary?.distance || 0,
          durationSeconds: feature.properties?.summary?.duration || 0,
          hasTollway: tollInfo.hasTollway,
          tollDistanceKm: tollInfo.tollDistanceKm,
          tollPercent: tollInfo.tollPercent,
          geometry: feature.geometry,
          provider: 'OpenRouteService',
        };
      });
    }
  } catch (err) {
    console.warn(
      'OpenRouteService request failed, falling back to OSRM:',
      err.response?.data?.error?.message || err.message
    );
  }

  // Fallback สำรอง: OSRM
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson`;
  const routeRes = await axios.get(osrmUrl, { timeout: 8000 });
  const route = routeRes.data.routes[0];

  if (!route) {
    throw new Error('ไม่พบเส้นทาง');
  }

  return [
    {
      id: 0,
      coordinates: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      hasTollway: false,
      tollDistanceKm: '0',
      tollPercent: 0,
      geometry: route.geometry,
      provider: 'OSRM (Fallback)',
    },
  ];
}

export async function analyzeRouteWeather({
  origin,
  destination,
  sampleIntervalKm = 4,
  departureOffsetMin = 0,
  vehicleType = 'motorcycle',
  avoidHighways = true,
  avoidTollways = true,
}) {
  // 1. ดึงเส้นทาง (พร้อมทางเลือกหลายเส้นทาง) จาก OpenRouteService
  const routesData = await fetchRoutesFromORS({ origin, destination, avoidHighways, avoidTollways });

  const departureDate = new Date(Date.now() + departureOffsetMin * 60 * 1000);
  const departureTimeFormatted = `${String(departureDate.getHours()).padStart(2, '0')}:${String(
    departureDate.getMinutes()
  ).padStart(2, '0')}`;

  const vehicleLabel = vehicleType === 'motorcycle' ? 'มอเตอร์ไซค์' : 'รถยนต์';
  const routeOptions = [];

  // 2. วิเคราะห์สภาพอากาศสำหรับแต่ละเส้นทาง
  for (let idx = 0; idx < routesData.length; idx++) {
    const route = routesData[idx];
    const checkpoints = sampleRoutePoints(route.coordinates, sampleIntervalKm);
    const totalDurationMin = Math.round(route.durationSeconds / 60);

    const checkpointResults = await fetchBatchWeather(checkpoints, departureDate, totalDurationMin);

    const rainPoints = checkpointResults.filter((p) => p.status !== 'SAFE');
    const maxProb = Math.max(...checkpointResults.map((p) => p.rainProbability), 0);

    let overallStatus = 'SAFE';
    let recommendation = `ออกเดินทางเวลา ${departureTimeFormatted} น. สำหรับ${vehicleLabel} (เส้นทางที่ ${idx + 1}) ถนนแห้ง ปลอดภัยตลอดสาย เดินทางได้สบายครับ`;

    if (checkpointResults.some((p) => p.status === 'DANGER')) {
      overallStatus = 'DANGER';
      recommendation = `หากออกเวลา ${departureTimeFormatted} น. สำหรับ${vehicleLabel} (เส้นทางที่ ${idx + 1}) มีจุดเสี่ยงฝนตกหนักตามเส้นทาง แนะนำเลื่อนเวลาเดินทางหรือเตรียมชุดกันฝน`;
    } else if (rainPoints.length > 0) {
      overallStatus = 'WARNING';
      recommendation = `หากออกเวลา ${departureTimeFormatted} น. สำหรับ${vehicleLabel} (เส้นทางที่ ${idx + 1}) มีโอกาสเจอละอองฝนบางช่วง ขับขี่ด้วยความระมัดระวังถนนลื่น`;
    }

    const routeName = idx === 0 ? 'เส้นทางที่ 1 (แนะนำ)' : `เส้นทางที่ ${idx + 1} (ทางเลือก)`;

    routeOptions.push({
      id: idx,
      name: routeName,
      distanceKm: (route.distanceMeters / 1000).toFixed(1),
      durationMin: totalDurationMin,
      durationFormatted: formatDuration(totalDurationMin),
      hasTollway: route.hasTollway,
      tollDistanceKm: route.tollDistanceKm,
      tollPercent: route.tollPercent,
      status: overallStatus,
      maxRainProbability: maxProb,
      rainPointsCount: rainPoints.length,
      recommendation,
      geometry: route.geometry,
      coordinates: route.coordinates,
      checkpoints: checkpointResults,
      routingProvider: route.provider,
    });
  }

  const primaryRoute = routeOptions[0];

  return {
    summary: {
      status: primaryRoute.status,
      departureTime: departureTimeFormatted,
      departureOffsetMin,
      vehicleType,
      avoidHighways: Boolean(avoidHighways),
      avoidTollways: Boolean(avoidTollways),
      totalDistanceKm: primaryRoute.distanceKm,
      totalDurationMin: primaryRoute.durationMin,
      durationFormatted: primaryRoute.durationFormatted,
      hasTollway: primaryRoute.hasTollway,
      tollDistanceKm: primaryRoute.tollDistanceKm,
      totalCheckpoints: primaryRoute.checkpoints.length,
      rainPointsCount: primaryRoute.rainPointsCount,
      maxRainProbability: primaryRoute.maxRainProbability,
      recommendation: primaryRoute.recommendation,
      routingProvider: primaryRoute.routingProvider,
    },
    routes: routeOptions,
    routeGeometry: primaryRoute.geometry,
    checkpoints: primaryRoute.checkpoints,
  };
}
