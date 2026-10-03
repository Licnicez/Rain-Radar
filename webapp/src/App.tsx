import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '@iconify/react';

export interface Checkpoint {
  id: number;
  lat: number;
  lon: number;
  etaTime?: string;
  rainProbability: number;
  rainAmountMm: number;
  status: 'SAFE' | 'WARNING' | 'DANGER';
}

export interface RouteOption {
  id: number;
  name: string;
  distanceKm: string;
  durationMin: number;
  durationFormatted: string;
  hasTollway: boolean;
  tollDistanceKm: string;
  status: 'SAFE' | 'WARNING' | 'DANGER';
  maxRainProbability: number;
  rainPointsCount: number;
  recommendation: string;
  geometry: {
    type: string;
    coordinates: [number, number][];
  };
  coordinates: { lat: number; lon: number }[];
  checkpoints: Checkpoint[];
  routingProvider?: string;
}

export interface RouteAnalysis {
  summary: {
    status: 'SAFE' | 'WARNING' | 'DANGER';
    departureTime?: string;
    departureOffsetMin?: number;
    vehicleType?: 'motorcycle' | 'car';
    avoidHighways?: boolean;
    avoidTollways?: boolean;
    totalDistanceKm: string;
    totalDurationMin: number;
    durationFormatted?: string;
    hasTollway?: boolean;
    tollDistanceKm?: string;
    totalCheckpoints: number;
    rainPointsCount: number;
    maxRainProbability: number;
    recommendation: string;
    routingProvider?: string;
  };
  routes?: RouteOption[];
  routeGeometry: {
    type: string;
    coordinates: [number, number][];
  };
  checkpoints: Checkpoint[];
}

export interface PlaceSuggestion {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
}

function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(((lon2 - lon1) * Math.PI) / 180);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} นาที`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hrs} ชม. ${rem} นาที` : `${hrs} ชม.`;
}

function checkHasTollway(feature: any) {
  const tollSummary = feature?.properties?.extras?.tollways?.summary;
  if (Array.isArray(tollSummary)) {
    const tollSegment = tollSummary.find((s: any) => s.value === 1);
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

function sampleRoutePoints(coordinates: { lat: number; lon: number }[], intervalKm = 4) {
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

const ORS_API_KEY =
  'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImNhMjQ0ZWMyMmQ3ZTRmMDZiZmUxNmNiYWJiM2U4NDdhIiwiaCI6Im11cm11cjY0In0=';

async function fetchRoutesFromORSClient({
  origin,
  destination,
  avoidHighways = true,
  avoidTollways = true,
}: {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  avoidHighways?: boolean;
  avoidTollways?: boolean;
}) {
  const postUrl = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';

  const avoid_features: string[] = [];
  if (avoidTollways) avoid_features.push('tollways');
  if (avoidHighways) avoid_features.push('highways');

  const requestBody: any = {
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
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: ORS_API_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    if (res.ok) {
      const data = await res.json();
      const features = data?.features;
      if (features && features.length > 0) {
        return features.map((feature: any, i: number) => {
          const tollInfo = checkHasTollway(feature);
          return {
            id: i,
            coordinates: feature.geometry.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon })),
            distanceMeters: feature.properties?.summary?.distance || 0,
            durationSeconds: feature.properties?.summary?.duration || 0,
            hasTollway: tollInfo.hasTollway,
            tollDistanceKm: tollInfo.tollDistanceKm,
            geometry: feature.geometry,
            provider: 'OpenRouteService',
          };
        });
      }
    }
  } catch (err: any) {
    console.warn('ORS client fetch failed, falling back to OSRM:', err?.message);
  }

  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson`;
  const routeRes = await fetch(osrmUrl);
  if (!routeRes.ok) {
    throw new Error('ไม่สามารถค้นหาเส้นทางจากเซิร์ฟเวอร์นำทางได้');
  }
  const routeJson = await routeRes.json();
  const route = routeJson?.routes?.[0];
  if (!route) {
    throw new Error('ไม่พบข้อมูลเส้นทางระหว่างจุดสองจุดนี้');
  }

  return [
    {
      id: 0,
      coordinates: route.geometry.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon })),
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      hasTollway: false,
      tollDistanceKm: '0',
      geometry: route.geometry,
      provider: 'OSRM (Fallback)',
    },
  ];
}

async function analyzeRouteClientSide({
  origin,
  destination,
  sampleIntervalKm = 4,
  departureOffsetMin = 0,
  vehicleType = 'motorcycle',
  avoidHighways = true,
  avoidTollways = true,
}: {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  sampleIntervalKm?: number;
  departureOffsetMin?: number;
  vehicleType?: 'motorcycle' | 'car';
  avoidHighways?: boolean;
  avoidTollways?: boolean;
}): Promise<RouteAnalysis> {
  const routesData = await fetchRoutesFromORSClient({ origin, destination, avoidHighways, avoidTollways });

  const departureDate = new Date(Date.now() + departureOffsetMin * 60 * 1000);
  const departureTimeFormatted = `${String(departureDate.getHours()).padStart(2, '0')}:${String(
    departureDate.getMinutes()
  ).padStart(2, '0')}`;

  const vehicleLabel = vehicleType === 'motorcycle' ? 'มอเตอร์ไซค์' : 'รถยนต์';
  const routeOptions: RouteOption[] = [];

  for (let idx = 0; idx < routesData.length; idx++) {
    const route = routesData[idx];
    const checkpoints = sampleRoutePoints(route.coordinates, sampleIntervalKm);
    const totalDurationMin = Math.round(route.durationSeconds / 60);

    const batchSize = 30;
    const allResults: Checkpoint[] = [];

    for (let i = 0; i < checkpoints.length; i += batchSize) {
      const chunk = checkpoints.slice(i, i + batchSize);
      const lats = chunk.map((pt) => pt.lat.toFixed(4)).join(',');
      const lons = chunk.map((pt) => pt.lon.toFixed(4)).join(',');

      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=precipitation_probability,rain&forecast_days=2&timezone=auto`;
      const weatherRes = await fetch(weatherUrl);
      if (!weatherRes.ok) {
        throw new Error('ไม่สามารถดึงข้อมูลพยากรณ์อากาศจาก Open-Meteo ได้');
      }
      const weatherData = await weatherRes.json();
      const weatherList = Array.isArray(weatherData) ? weatherData : [weatherData];

      chunk.forEach((pt, index) => {
        const globalIndex = i + index;
        const wData = weatherList[index] || weatherList[0];
        const hourly = wData?.hourly || {};
        const timeArray: string[] = hourly.time || [];

        const progressRatio = checkpoints.length > 1 ? globalIndex / (checkpoints.length - 1) : 0;
        const etaMinutes = progressRatio * totalDurationMin;
        const etaDate = new Date(departureDate.getTime() + etaMinutes * 60 * 1000);

        const yr = etaDate.getFullYear();
        const mo = String(etaDate.getMonth() + 1).padStart(2, '0');
        const da = String(etaDate.getDate()).padStart(2, '0');
        const hr = String(etaDate.getHours()).padStart(2, '0');
        const matchHourStr = `${yr}-${mo}-${da}T${hr}:00`;

        let timeIdx = timeArray.findIndex((t: string) => t.startsWith(matchHourStr));
        if (timeIdx === -1) {
          timeIdx = 0;
        }

        const rainProb = (hourly.precipitation_probability && hourly.precipitation_probability[timeIdx]) ?? 0;
        const rainAmount = (hourly.rain && hourly.rain[timeIdx]) ?? 0;

        let status: 'SAFE' | 'WARNING' | 'DANGER' = 'SAFE';
        if (rainProb > 60 || rainAmount >= 2.5) {
          status = 'DANGER';
        } else if (rainProb > 30 || rainAmount > 0.5) {
          status = 'WARNING';
        }

        const etaFormatted = `${String(etaDate.getHours()).padStart(2, '0')}:${String(etaDate.getMinutes()).padStart(
          2,
          '0'
        )}`;

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
    }

    const rainPoints = allResults.filter((cp) => cp.status !== 'SAFE');
    const dangerPoints = allResults.filter((cp) => cp.status === 'DANGER');
    let overallStatus: 'SAFE' | 'WARNING' | 'DANGER' = 'SAFE';

    if (dangerPoints.length > 0) {
      overallStatus = 'DANGER';
    } else if (rainPoints.length > 0) {
      overallStatus = 'WARNING';
    }

    const maxProb = allResults.reduce((max, cp) => Math.max(max, cp.rainProbability), 0);

    let recommendation = `เส้นทางสะดวก ขับขี่${vehicleLabel}ได้ปลอดภัยตลอดทาง แดดดีหรือถนนแห้ง`;
    if (overallStatus === 'DANGER') {
      recommendation = `พบจุดฝนตกหนักหรือมีความเสี่ยงสูง แนะนำเตรียมชุดกันฝน หรือหลีกเลี่ยงการเดินทางช่วงเวลานี้`;
    } else if (overallStatus === 'WARNING') {
      recommendation = `มีโอกาสพบละอองฝนบางช่วง ขับขี่ด้วยความระมัดระวัง ลดความเร็วลง`;
    }

    const routeName = idx === 0 ? 'เส้นทางที่ 1 (แนะนำ)' : `เส้นทางที่ ${idx + 1} (ทางเลือก)`;

    routeOptions.push({
      id: idx,
      name: routeName,
      distanceKm: (route.distanceMeters / 1000).toFixed(1),
      durationMin: totalDurationMin,
      durationFormatted: formatDuration(totalDurationMin),
      hasTollway: Boolean(route.hasTollway),
      tollDistanceKm: route.tollDistanceKm || '0',
      status: overallStatus,
      maxRainProbability: maxProb,
      rainPointsCount: rainPoints.length,
      recommendation,
      geometry: route.geometry,
      coordinates: route.coordinates,
      checkpoints: allResults,
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

const createSelectedRouteBadge = (route: RouteOption, idx?: number) => {
  const isRain = route.maxRainProbability > 30;
  return L.divIcon({
    className: 'route-badge-selected',
    html: `
      <div style="position: relative; transform: translate(-50%, -100%); cursor: pointer; pointer-events: auto;">
        <div style="background: #1a73e8; color: #ffffff; padding: 6px 12px; border-radius: 14px; box-shadow: 0 4px 18px rgba(26,115,232,0.45); font-family: 'Prompt', sans-serif; white-space: nowrap; border: 2.5px solid #ffffff; display: flex; flex-direction: column; align-items: center; min-width: 95px; pointer-events: auto;">
          <div style="display: flex; align-items: center; gap: 5px; font-weight: 900; font-size: 0.88rem;">
            <span>${route.durationFormatted || route.durationMin + ' นาที'}</span>
            <span>${isRain ? '🌧️' : '🍃'}</span>
          </div>
          <div style="font-size: 0.72rem; opacity: 0.95; font-weight: 700; margin-top: 1px;">
            ${route.hasTollway ? 'Tolls (ทางด่วน)' : 'No tolls (ทางราบ)'}
          </div>
        </div>
        <div style="width: 0; height: 0; border-left: 7px solid transparent; border-right: 7px solid transparent; border-top: 8px solid #1a73e8; margin: 0 auto;"></div>
      </div>
    `,
    iconSize: [115, 50],
    iconAnchor: [57.5, 50],
  });
};

const createAltRouteBadge = (route: RouteOption, idx?: number) => {
  const isRain = route.maxRainProbability > 30;
  const clickAttr = typeof idx === 'number' ? `onclick="if(window.__selectRoute){window.__selectRoute(${idx});}"` : '';
  return L.divIcon({
    className: 'route-badge-alt',
    html: `
      <div ${clickAttr} style="position: relative; transform: translate(-50%, -100%); cursor: pointer; pointer-events: auto;">
        <div style="background: #ffffff; color: #3c4043; padding: 6px 11px; border-radius: 14px; box-shadow: 0 4px 14px rgba(0,0,0,0.18); font-family: 'Prompt', sans-serif; white-space: nowrap; border: 1.5px solid #dadce0; display: flex; flex-direction: column; align-items: center; min-width: 90px; pointer-events: auto;">
          <div style="display: flex; align-items: center; gap: 5px; font-weight: 800; font-size: 0.85rem; color: #202124;">
            <span>${route.durationFormatted || route.durationMin + ' นาที'}</span>
            <span>${isRain ? '🌧️' : '🍃'}</span>
          </div>
          <div style="font-size: 0.7rem; color: #5f6368; font-weight: 600; margin-top: 1px;">
            ${route.hasTollway ? 'Tolls' : 'No tolls'}
          </div>
        </div>
        <div style="width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 7px solid #ffffff; margin: 0 auto;"></div>
      </div>
    `,
    iconSize: [110, 48],
    iconAnchor: [55, 48],
  });
};

const createVehicleNavIcon = (heading: number | null, vehicleType: 'motorcycle' | 'car' = 'motorcycle') => {
  const rotation = heading !== null && !isNaN(heading) ? Math.round(heading) : 0;
  const isCar = vehicleType === 'car';
  const pulseColor = isCar ? 'rgba(59, 130, 246, 0.35)' : 'rgba(16, 185, 129, 0.35)';
  const badgeColor = isCar ? '#2563eb' : '#059669';

  const iconSvg = isCar
    ? `<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11M3 11h18v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="7.5" cy="15" r="1.5" fill="#ffffff"/><circle cx="16.5" cy="15" r="1.5" fill="#ffffff"/>`
    : `<circle cx="6" cy="16" r="3" stroke="#ffffff" stroke-width="2" fill="none"/><circle cx="18" cy="16" r="3" stroke="#ffffff" stroke-width="2" fill="none"/><path d="M6 16l4-6h4l3 6M12 10V6h3" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

  return L.divIcon({
    className: 'nav-vehicle-marker',
    html: `
      <div style="position: relative; width: 68px; height: 68px; display: flex; align-items: center; justify-content: center;">
        <!-- Pulsing Radar Pulse Ring -->
        <div style="position: absolute; width: 60px; height: 60px; border-radius: 50%; background: ${pulseColor}; animation: navPulse 2s ease-out infinite;"></div>

        <!-- Rotating Direction & Vehicle Container (หมุนตามทิศ heading พร้อมลูกศรบอกทิศ) -->
        <div style="position: absolute; width: 68px; height: 68px; transform: rotate(${rotation}deg); transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); pointer-events: none; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          
          <!-- ลูกศรบอกทิศทางขนาดใหญ่ที่หัวเรา ชี้ไปข้างหน้าชัดเจน -->
          <div style="position: absolute; top: 0px; z-index: 5; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.45));">
            <svg width="22" height="18" viewBox="0 0 22 18" fill="none">
              <path d="M11 1L20 16L11 12.5L2 16L11 1Z" fill="${isCar ? '#2563eb' : '#059669'}" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
            </svg>
          </div>

          <!-- ลำแสงพุ่งไปข้างหน้า (Forward Heading Beam) -->
          <div style="position: absolute; top: 2px; width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 24px solid rgba(56, 189, 248, 0.45); filter: blur(2px);"></div>

          <!-- วงกลมสัญลักษณ์ยานพาหนะตรงกลาง -->
          <div style="position: relative; width: 40px; height: 40px; border-radius: 50%; background: ${badgeColor}; box-shadow: 0 4px 16px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; border: 2.8px solid #ffffff; z-index: 4;">
            <div style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                ${iconSvg}
              </svg>
            </div>
          </div>
        </div>
      </div>
    `,
    iconSize: [68, 68],
    iconAnchor: [34, 34],
  });
};

function NavigationFollower({
  isTracking,
  autoFollow,
  setAutoFollow,
  liveLocation,
  origin,
  povMode,
  routeCoords,
  recenterTrigger,
}: {
  isTracking: boolean;
  autoFollow: boolean;
  setAutoFollow: (val: boolean) => void;
  liveLocation: { lat: number; lon: number } | null;
  origin: { lat: number; lon: number };
  povMode: 'DRIVER_CLOSE' | 'DRIVER_FAR' | 'OVERVIEW';
  routeCoords: [number, number][];
  recenterTrigger?: number;
}) {
  const map = useMap();
  const lastModeRef = useRef<string>('');

  // เมื่อผู้ใช้ลาก/เลื่อนแผนที่เอง ให้ปลด autoFollow ชั่วคราว
  useEffect(() => {
    const handleDragStart = () => {
      if (isTracking) {
        setAutoFollow(false);
      }
    };
    map.on('dragstart', handleDragStart);
    return () => {
      map.off('dragstart', handleDragStart);
    };
  }, [map, isTracking, setAutoFollow]);

  // สลับโหมดมุมมอง หรือกดปุ่มดึงกลับมาที่ตัวเรา
  useEffect(() => {
    if (!isTracking) {
      lastModeRef.current = '';
      return;
    }

    const target = liveLocation || origin;

    if (povMode === 'DRIVER_CLOSE') {
      if (target) {
        map.flyTo([target.lat, target.lon], 18, {
          animate: true,
          duration: 0.9,
        });
        lastModeRef.current = 'DRIVER_CLOSE';
      }
    } else if (povMode === 'DRIVER_FAR') {
      if (target) {
        map.flyTo([target.lat, target.lon], 14, {
          animate: true,
          duration: 0.9,
        });
        lastModeRef.current = 'DRIVER_FAR';
      }
    } else if (povMode === 'OVERVIEW') {
      lastModeRef.current = 'OVERVIEW';
      if (routeCoords && routeCoords.length > 0) {
        map.fitBounds(routeCoords, {
          padding: [60, 60],
          maxZoom: 15,
          animate: true,
        });
      }
    }
  }, [isTracking, povMode, recenterTrigger, map]);

  // ติดตามการเคลื่อนที่สดของตำแหน่งตัวเรา (เมื่อ autoFollow เปิดอยู่)
  useEffect(() => {
    if (!isTracking || !autoFollow) return;

    const target = liveLocation || origin;
    if (!target) return;

    if (povMode === 'DRIVER_CLOSE') {
      const currentZoom = map.getZoom();
      if (lastModeRef.current !== 'DRIVER_CLOSE' || currentZoom < 16.5) {
        map.flyTo([target.lat, target.lon], 18, { animate: true, duration: 0.8 });
        lastModeRef.current = 'DRIVER_CLOSE';
      } else {
        map.panTo([target.lat, target.lon], { animate: true, duration: 0.4 });
      }
    } else if (povMode === 'DRIVER_FAR') {
      const currentZoom = map.getZoom();
      if (lastModeRef.current !== 'DRIVER_FAR' || Math.abs(currentZoom - 14) > 1.5) {
        map.flyTo([target.lat, target.lon], 14, { animate: true, duration: 0.8 });
        lastModeRef.current = 'DRIVER_FAR';
      } else {
        map.panTo([target.lat, target.lon], { animate: true, duration: 0.4 });
      }
    }
  }, [isTracking, autoFollow, liveLocation?.lat, liveLocation?.lon, povMode, map, origin]);

  return null;
}

function MapFlyController({ target }: { target: { lat: number; lon: number; zoom: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo([target.lat, target.lon], target.zoom, { animate: true, duration: 1.2 });
    }
  }, [target]);
  return null;
}

function MapController({
  origin,
  destination,
  routeCoords,
  isTracking,
}: {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number } | null;
  routeCoords?: [number, number][];
  isTracking?: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (isTracking) return;

    if (routeCoords && routeCoords.length > 0) {
      map.fitBounds(routeCoords, { padding: [70, 70], maxZoom: 15 });
    } else if (origin && destination) {
      map.fitBounds(
        [
          [origin.lat, origin.lon],
          [destination.lat, destination.lon],
        ],
        { padding: [70, 70], maxZoom: 14 }
      );
    } else if (origin) {
      map.setView([origin.lat, origin.lon], 13);
    }
  }, [routeCoords, origin?.lat, origin?.lon, destination?.lat, destination?.lon, isTracking]);

  return null;
}

export function App() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RouteAnalysis | null>(null);

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [origin, setOrigin] = useState({ lat: 13.8027, lon: 100.5539 });
  const [originName, setOriginName] = useState('ตำแหน่งปัจจุบันของคุณ');
  const [isGpsLoading, setIsGpsLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && navigator.geolocation) {
      setIsGpsLoading(true);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = Number(pos.coords.latitude.toFixed(6));
          const lon = Number(pos.coords.longitude.toFixed(6));
          setOrigin({ lat, lon });
          setIsGpsLoading(false);

          try {
            const revUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`;
            const res = await fetch(revUrl, { headers: { 'Accept-Language': 'th,en' } });
            const revData = await res.json();
            if (revData && revData.display_name) {
              const shortName = revData.display_name.split(',').slice(0, 3).join(', ');
              setOriginName(shortName);
            } else {
              setOriginName('ตำแหน่งปัจจุบันของคุณ');
            }
          } catch {
            setOriginName('ตำแหน่งปัจจุบันของคุณ');
          }
        },
        (err) => {
          console.warn('Auto geolocation error/skipped:', err?.message);
          setIsGpsLoading(false);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
  }, []);

  const [floodData, setFloodData] = useState<any>(null);
  const [showFloodLayer, setShowFloodLayer] = useState<boolean>(true);
  const [floodPeriod, setFloodPeriod] = useState<'1day' | '7days'>('7days');
  const [isFloodLoading, setIsFloodLoading] = useState<boolean>(false);
  const [showFloodMenu, setShowFloodMenu] = useState<boolean>(false);
  const [mapFlyTarget, setMapFlyTarget] = useState<{ lat: number; lon: number; zoom: number } | null>(null);

  const fetchFloodData = async (period: '1day' | '7days' = '1day') => {
    setIsFloodLoading(true);
    try {
      if (period === '1day') {
        const res1 = await fetch(
          'https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/1day?limit=1000&offset=0',
          {
            headers: {
              accept: 'application/json',
              'API-Key': 'iW8NtubTP0sqLeXaxMkvXZwvZJOIAnYJGf6ka1xc95LBz174Xu5dKwlrSKYx5j1b',
            },
          }
        );
        if (res1.ok) {
          const json1 = await res1.json();
          if (json1.features && json1.features.length > 0) {
            setFloodData(json1);
            setFloodPeriod('1day');
            setIsFloodLoading(false);
            return;
          }
        }
      }

      const targetEndpoint = period === '1day' ? '7days' : period;
      const zones = [
        { name: 'อยุธยาและปริมณฑล', bbox: '100.2,14.0,100.8,14.6', limit: 500 },
        { name: 'ภาคกลางตอนบน', bbox: '99.5,14.6,101.5,15.6', limit: 600 },
        { name: 'ภาคเหนือ', bbox: '98.0,15.6,101.5,20.5', limit: 800 },
        { name: 'ภาคอีสาน', bbox: '101.5,14.0,105.8,18.5', limit: 800 },
        { name: 'ภาคตะวันออกและใต้', bbox: '98.0,5.5,103.0,13.5', limit: 400 },
      ];

      const promises = zones.map((z) =>
        fetch(
          `https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/${targetEndpoint}?bbox=${z.bbox}&limit=${z.limit}&offset=0`,
          {
            headers: {
              accept: 'application/json',
              'API-Key': 'iW8NtubTP0sqLeXaxMkvXZwvZJOIAnYJGf6ka1xc95LBz174Xu5dKwlrSKYx5j1b',
            },
          }
        )
          .then((r) => (r.ok ? r.json() : { features: [] }))
          .catch(() => ({ features: [] }))
      );

      const results = await Promise.all(promises);
      const allFeatures = results.flatMap((r) => r.features || []);

      setFloodData({
        type: 'FeatureCollection',
        features: allFeatures,
      });
      setFloodPeriod(targetEndpoint as any);
    } catch (err: any) {
      console.warn('GISTDA Flood fetch warning:', err?.message);
    } finally {
      setIsFloodLoading(false);
    }
  };

  useEffect(() => {
    fetchFloodData('1day');
  }, []);

  const [destination, setDestination] = useState<{ lat: number; lon: number } | null>(null);
  const [destinationName, setDestinationName] = useState<string>('');
  const [departureOffsetMin, setDepartureOffsetMin] = useState(0);

  const [vehicleType, setVehicleType] = useState<'motorcycle' | 'car'>('motorcycle');
  const [avoidTollways, setAvoidTollways] = useState<boolean>(true);
  const [avoidHighways, setAvoidHighways] = useState<boolean>(true);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(0);

  useEffect(() => {
    (window as any).__selectRoute = (idx: number) => {
      setSelectedRouteIndex(idx);
    };
    return () => {
      delete (window as any).__selectRoute;
    };
  }, []);

  const [activeSheet, setActiveSheet] = useState<'NONE' | 'LOCATIONS' | 'TIME' | 'AVOID' | 'SUMMARY'>('NONE');

  const [isTracking, setIsTracking] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [povMode, setPovMode] = useState<'DRIVER_CLOSE' | 'DRIVER_FAR' | 'OVERVIEW'>('DRIVER_CLOSE');
  const [recenterTrigger, setRecenterTrigger] = useState(0);
  const [liveLocation, setLiveLocation] = useState<{
    lat: number;
    lon: number;
    heading: number | null;
    speed: number | null;
    accuracy: number;
  } | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const prevLocationRef = useRef<{ lat: number; lon: number; heading: number | null } | null>(null);

  const toggleTracking = () => {
    if (isTracking) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setIsTracking(false);
    } else {
      if (!destination) {
        setActiveSheet('LOCATIONS');
        alert('กรุณาเลือกจุดหมายปลายทางก่อนเริ่มเดินทางครับ');
        return;
      }

      if (!navigator.geolocation) {
        alert('เบราว์เซอร์ของคุณไม่รองรับการดักจับตำแหน่ง GPS แบบ Real-time');
        return;
      }

      setIsTracking(true);
      setAutoFollow(true);
      setPovMode('DRIVER_CLOSE');
      setRecenterTrigger((c) => c + 1);
      setActiveSheet('NONE');

      if (!data) {
        handleCheckRain();
      }

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude, heading, speed, accuracy } = pos.coords;
          let calculatedHeading = heading;

          if ((calculatedHeading === null || isNaN(calculatedHeading)) && prevLocationRef.current) {
            const dLat = Math.abs(latitude - prevLocationRef.current.lat);
            const dLon = Math.abs(longitude - prevLocationRef.current.lon);
            if (dLat > 0.00003 || dLon > 0.00003) {
              calculatedHeading = calculateBearing(
                prevLocationRef.current.lat,
                prevLocationRef.current.lon,
                latitude,
                longitude
              );
            } else {
              calculatedHeading = prevLocationRef.current.heading;
            }
          }

          if ((calculatedHeading === null || isNaN(calculatedHeading)) && data?.routes?.[selectedRouteIndex]?.geometry?.coordinates) {
            const coords = data.routes[selectedRouteIndex].geometry.coordinates;
            if (coords && coords.length >= 2) {
              calculatedHeading = calculateBearing(coords[0][1], coords[0][0], coords[1][1], coords[1][0]);
            }
          }

          const speedKmh = speed !== null && !isNaN(speed) ? Math.round(speed * 3.6) : 0;

          setLiveLocation({
            lat: latitude,
            lon: longitude,
            heading: calculatedHeading,
            speed: speedKmh,
            accuracy: Math.round(accuracy),
          });

          prevLocationRef.current = { lat: latitude, lon: longitude, heading: calculatedHeading };
          setOrigin({ lat: latitude, lon: longitude });
          setOriginName('ตำแหน่งสดของคุณ (Live GPS)');
        },
        (err) => {
          console.warn('watchPosition error:', err);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 1000,
          timeout: 10000,
        }
      );
    }
  };

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  const [originSuggestions, setOriginSuggestions] = useState<PlaceSuggestion[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showOriginDropdown, setShowOriginDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);
  const originInputRef = useRef<HTMLDivElement>(null);
  const destInputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!originName || originName.length < 2) {
      setOriginSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          originName
        )}&countrycodes=th&limit=5&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'th,en' } });
        const json = await res.json();
        setOriginSuggestions(json || []);
      } catch {}
    }, 400);
    return () => clearTimeout(timer);
  }, [originName]);

  useEffect(() => {
    if (!destinationName || destinationName.length < 2) {
      setDestSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          destinationName
        )}&countrycodes=th&limit=5&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'th,en' } });
        const json = await res.json();
        setDestSuggestions(json || []);
      } catch {}
    }, 400);
    return () => clearTimeout(timer);
  }, [destinationName]);

  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert('เบราว์เซอร์ของคุณไม่รองรับการระบุตำแหน่ง GPS');
      return;
    }

    setIsGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lon = Number(pos.coords.longitude.toFixed(6));
        setOrigin({ lat, lon });
        setOriginName('ตำแหน่งปัจจุบันของคุณ');
        setShowOriginDropdown(false);
        setIsGpsLoading(false);

        try {
          const revUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`;
          const res = await fetch(revUrl, { headers: { 'Accept-Language': 'th,en' } });
          const revData = await res.json();
          if (revData && revData.display_name) {
            const shortName = revData.display_name.split(',').slice(0, 3).join(', ');
            setOriginName(shortName);
          }
        } catch {}
      },
      (err) => {
        setIsGpsLoading(false);
        alert('ไม่สามารถดึงตำแหน่งปัจจุบันได้: ' + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSwapLocations = () => {
    if (!destination) return;
    const tempOrigin = { ...origin };
    const tempOriginName = originName;
    setOrigin(destination);
    setOriginName(destinationName);
    setDestination(tempOrigin);
    setDestinationName(tempOriginName);
  };

  const getDepartureTimeLabel = (offsetMinutes: number) => {
    const targetDate = new Date(Date.now() + offsetMinutes * 60 * 1000);
    const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')} น.`;
    if (offsetMinutes === 0) return `ตอนนี้ (${timeStr})`;
    const hrs = Math.floor(offsetMinutes / 60);
    const mins = offsetMinutes % 60;
    const durStr = hrs > 0 ? (mins > 0 ? `+${hrs} ชม. ${mins} นาที` : `+${hrs} ชม.`) : `+${mins} นาที`;
    return `${durStr} (${timeStr})`;
  };

  const handleCheckRain = async (
    targetVehicle?: 'motorcycle' | 'car',
    targetAvoidTollways?: boolean,
    targetAvoidHighways?: boolean,
    customDestination?: { lat: number; lon: number; name?: string }
  ) => {
    const targetDest = customDestination ? { lat: customDestination.lat, lon: customDestination.lon } : destination;
    if (!targetDest) {
      setActiveSheet('LOCATIONS');
      return;
    }

    const activeVehicle = targetVehicle ?? vehicleType;
    const activeAvoidTollways = targetAvoidTollways ?? avoidTollways;
    const activeAvoidHighways = targetAvoidHighways ?? avoidHighways;
    setLoading(true);
    setSelectedRouteIndex(0);
    try {
      let resultData: RouteAnalysis | null = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);

        const res = await fetch('https://rain-radar.onrender.com/api/analyze-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin,
            destination: targetDest,
            sampleIntervalKm: 4,
            departureOffsetMin,
            vehicleType: activeVehicle,
            avoidHighways: activeAvoidHighways,
            avoidTollways: activeAvoidTollways,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json();
          if (json.status === 'success' && json.data && json.data.summary?.vehicleType === activeVehicle) {
            resultData = json.data;
          }
        }
      } catch (backendErr: any) {
        console.warn('Render API connection skipped/timeout:', backendErr.message);
      }

      if (!resultData) {
        resultData = await analyzeRouteClientSide({
          origin,
          destination: targetDest,
          sampleIntervalKm: 4,
          departureOffsetMin,
          vehicleType: activeVehicle,
          avoidHighways: activeAvoidHighways,
          avoidTollways: activeAvoidTollways,
        });
      }

      setData(resultData);
      setActiveSheet('NONE');
    } catch (err: any) {
      alert('ไม่สามารถตรวจสอบเส้นทางได้: ' + (err?.message || 'เกิดข้อผิดพลาดในการดึงข้อมูล'));
    } finally {
      setLoading(false);
    }
  };

  const selectQuickDestination = (dest: { name: string; lat: number; lon: number }) => {
    setDestination({ lat: dest.lat, lon: dest.lon });
    setDestinationName(dest.name);
    setShowDestDropdown(false);
    handleCheckRain(vehicleType, avoidTollways, avoidHighways, { lat: dest.lat, lon: dest.lon, name: dest.name });
  };

  const getStatusColor = (status: string) => {
    if (status === 'DANGER') return '#ef4444';
    if (status === 'WARNING') return '#f59e0b';
    return '#10b981';
  };

  const getStatusText = (status: string) => {
    if (status === 'DANGER') return 'เสี่ยงฝนตก';
    if (status === 'WARNING') return 'ระวังละอองฝน';
    return 'ถนนแห้ง ปลอดภัย';
  };

  const activeRoute = (data?.routes && data.routes[selectedRouteIndex]) ? data.routes[selectedRouteIndex] : (data ? {
    id: 0,
    name: 'เส้นทางหลัก',
    distanceKm: data.summary.totalDistanceKm,
    durationMin: data.summary.totalDurationMin,
    durationFormatted: data.summary.durationFormatted || formatDuration(data.summary.totalDurationMin),
    hasTollway: Boolean(data.summary.hasTollway),
    tollDistanceKm: data.summary.tollDistanceKm || '0',
    status: data.summary.status,
    maxRainProbability: data.summary.maxRainProbability,
    rainPointsCount: data.summary.rainPointsCount,
    recommendation: data.summary.recommendation,
    geometry: data.routeGeometry,
    coordinates: [],
    checkpoints: data.checkpoints,
    routingProvider: data.summary.routingProvider,
  } : null);

  const polylinePositions =
    activeRoute?.geometry?.coordinates.map(([lon, lat]: [number, number]) => [lat, lon] as [number, number]) || [];

  return (
    <div
      style={{
        position: 'relative',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: '#f8fafc',
        fontFamily: "'Prompt', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <style>{`
        @keyframes radarSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes scanProgressAnim {
          0% { width: 10%; transform: translateX(-10%); }
          50% { width: 80%; transform: translateX(15%); }
          100% { width: 100%; transform: translateX(0%); }
        }
        @keyframes navPulse {
          0% { transform: scale(0.8); opacity: 0.8; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>

      {/* แผนที่เต็มจอ */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
        <MapContainer
          center={[origin.lat, origin.lon]}
          zoom={12}
          zoomControl={false}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {showFloodLayer && (
            <TileLayer
              key={`gistda-wmts-${floodPeriod}`}
              url={`https://api-gateway.gistda.or.th/api/2.0/resources/maps/flood/${floodPeriod}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vallaris-blank&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png&api_key=iW8NtubTP0sqLeXaxMkvXZwvZJOIAnYJGf6ka1xc95LBz174Xu5dKwlrSKYx5j1b`}
              opacity={0.8}
              zIndex={350}
              maxZoom={18}
            />
          )}

          <MapController
            origin={origin}
            destination={destination}
            routeCoords={polylinePositions}
            isTracking={isTracking}
          />

          <MapFlyController target={mapFlyTarget} />
          <NavigationFollower
            isTracking={isTracking}
            autoFollow={autoFollow}
            setAutoFollow={setAutoFollow}
            liveLocation={liveLocation}
            origin={origin}
            povMode={povMode}
            routeCoords={polylinePositions}
            recenterTrigger={recenterTrigger}
          />

          {!isTracking && (
            <CircleMarker
              center={[origin.lat, origin.lon]}
              radius={10}
              pathOptions={{
                fillColor: '#10b981',
                fillOpacity: 1,
                color: '#ffffff',
                weight: 3,
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.82rem' }}>
                  <strong style={{ color: '#047857' }}>🟢 จุดเริ่มต้น</strong><br />
                  {originName}
                </div>
              </Popup>
            </CircleMarker>
          )}

          {destination && (
            <CircleMarker
              center={[destination.lat, destination.lon]}
              radius={10}
              pathOptions={{
                fillColor: '#ef4444',
                fillOpacity: 1,
                color: '#ffffff',
                weight: 3,
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.82rem' }}>
                  <strong style={{ color: '#b91c1c' }}>🔴 จุดหมายปลายทาง</strong><br />
                  {destinationName || 'จุดหมายปลายทาง'}
                </div>
              </Popup>
            </CircleMarker>
          )}

          {liveLocation && (
            <Marker
              position={[liveLocation.lat, liveLocation.lon]}
              icon={createVehicleNavIcon(liveLocation.heading, vehicleType)}
              zIndexOffset={1000}
            >
              <Popup>
                <div style={{ fontSize: '0.82rem' }}>
                  <strong style={{ color: vehicleType === 'motorcycle' ? '#059669' : '#2563eb' }}>
                    {vehicleType === 'motorcycle' ? 'มอเตอร์ไซค์ของคุณ' : 'รถยนต์ของคุณ'} (Live GPS)
                  </strong><br />
                  ความเร็ว: <strong>{liveLocation.speed} กม./ชม.</strong><br />
                  ทิศทาง: <strong>{liveLocation.heading !== null ? Math.round(liveLocation.heading) : 0}°</strong>
                </div>
              </Popup>
            </Marker>
          )}

          {/* 1. เลเยอร์พื้นที่น้ำท่วมจาก GISTDA (วาดไว้ใต้เส้นทาง เพื่อไม่ให้บังการคลิกเส้นทาง) */}
          {showFloodLayer && floodData && Array.isArray(floodData.features) && floodData.features.length > 0 && (
            <GeoJSON
              key={`flood-${floodPeriod}-${floodData.features.length}`}
              data={floodData}
              style={() => ({
                fillColor: '#0284c7',
                fillOpacity: 0.45,
                color: '#0369a1',
                weight: 1.5,
                dashArray: '3, 3',
              })}
              onEachFeature={(feature: any, layer: any) => {
                const p = feature.properties || {};
                const areaRai = p.f_area ? (p.f_area / 1600).toFixed(1) : (p._area ? (p._area / 1600).toFixed(1) : '-');
                const areaSqm = p.f_area ? Math.round(p.f_area).toLocaleString() : (p._area ? Math.round(p._area).toLocaleString() : '-');
                const dateStr = p._updatedAt || p._createdAt || '';
                const formattedDate = dateStr ? new Date(dateStr).toLocaleDateString('th-TH') : '-';
                layer.bindPopup(`
                  <div style="font-family: 'Prompt', sans-serif; font-size: 0.85rem; min-width: 180px;">
                    <div style="display: flex; align-items: center; gap: 6px; color: #0284c7; font-weight: 800; font-size: 0.95rem; margin-bottom: 6px;">
                      <span>🌊</span> <span>พื้นที่น้ำท่วม (GISTDA)</span>
                    </div>
                    <div style="margin-bottom: 2px;"><strong>จังหวัด:</strong> ${p.pv_tn || p.pv_en || '-'}</div>
                    <div style="margin-bottom: 2px;"><strong>อำเภอ:</strong> ${p.ap_tn || p.ap_en || '-'}</div>
                    <div style="margin-bottom: 2px;"><strong>ตำบล:</strong> ${p.tb_tn || p.tb_en || '-'}</div>
                    <div style="margin-bottom: 2px;"><strong>ขนาดพื้นที่:</strong> <span style="color: #0369a1; font-weight: 700;">${areaRai} ไร่</span> (${areaSqm} ตร.ม.)</div>
                    <div style="font-size: 0.72rem; color: #64748b; margin-top: 6px; border-top: 1px dashed #e2e8f0; padding-top: 4px;">อัปเดตดาวเทียม: ${formattedDate}</div>
                  </div>
                `);
              }}
            />
          )}

          {/* 2. เส้นทางทั้งหมด (เรียงให้เส้นเทาวาดก่อน แล้วเส้นน้ำเงินที่เลือกวาดทับด้านบน) */}
          {data?.routes && (() => {
            const indexedRoutes = data.routes.map((rt, idx) => ({ ...rt, originalIdx: idx }));
            // เรียงให้เส้นที่เลือกอยู่ลำดับสุดท้าย เพื่อให้อยู่บนสุดใน SVG
            const sortedRoutes = [...indexedRoutes].sort((a, b) => {
              if (a.originalIdx === selectedRouteIndex) return 1;
              if (b.originalIdx === selectedRouteIndex) return -1;
              return 0;
            });

            return sortedRoutes.map((rt) => {
              const isSelected = selectedRouteIndex === rt.originalIdx;
              const positions = rt.geometry.coordinates.map(([lon, lat]: [number, number]) => [lat, lon] as [number, number]);
              if (positions.length === 0) return null;

              const midFactor = rt.originalIdx === 0 ? 0.42 : (0.52 + (rt.originalIdx * 0.08));
              const midIndex = Math.min(Math.floor(positions.length * midFactor), positions.length - 1);
              const badgePosition = positions[midIndex];

              return (
                <React.Fragment key={`route-group-${rt.originalIdx}`}>
                  {/* 2.1 เส้นคลิกอ้วนโปร่งใส (Fat Click Area) กว้าง 36px เพื่อให้แตะหรือคลิกบนเส้นสีเทาได้ง่ายและติดแน่นอน */}
                  <Polyline
                    positions={positions}
                    pathOptions={{
                      color: '#000000',
                      opacity: 0.0001,
                      weight: 36,
                      lineCap: 'round',
                      lineJoin: 'round',
                      interactive: true,
                    }}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setSelectedRouteIndex(rt.originalIdx);
                      },
                    }}
                  />

                  {/* 2.2 เส้นทางที่มองเห็น (Visible Polyline: สีน้ำเงิน = เลือก, สีเทา = ยังไม่เลือก) */}
                  <Polyline
                    positions={positions}
                    pathOptions={{
                      color: isSelected ? '#1a73e8' : '#78909c',
                      weight: isSelected ? 8 : 6,
                      opacity: isSelected ? 1 : 0.8,
                      lineCap: 'round',
                      lineJoin: 'round',
                      interactive: true,
                    }}
                    eventHandlers={{
                      click: (e) => {
                        L.DomEvent.stopPropagation(e);
                        setSelectedRouteIndex(rt.originalIdx);
                      },
                    }}
                  />

                  {/* 2.3 ป้ายเวลาบนเส้นทาง (Google Maps Callout Marker) */}
                  {badgePosition && (
                    <Marker
                      position={badgePosition}
                      icon={isSelected ? createSelectedRouteBadge(rt, rt.originalIdx) : createAltRouteBadge(rt, rt.originalIdx)}
                      zIndexOffset={isSelected ? 3000 : 1500}
                      eventHandlers={{
                        click: (e) => {
                          L.DomEvent.stopPropagation(e);
                          setSelectedRouteIndex(rt.originalIdx);
                        },
                      }}
                    />
                  )}
                </React.Fragment>
              );
            });
          })()}

          {/* 3. จุดตรวจสภาพอากาศ */}
          {(activeRoute?.checkpoints || data?.checkpoints || []).map((pt) => (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lon]}
              radius={7}
              pathOptions={{
                fillColor: getStatusColor(pt.status),
                fillOpacity: 1,
                color: '#ffffff',
                weight: 2,
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.82rem' }}>
                  <strong>จุดที่ {pt.id} {pt.etaTime && `(ถึง ~ ${pt.etaTime} น.)`}</strong><br />
                  สถานะ: <span style={{ color: getStatusColor(pt.status), fontWeight: 700 }}>{getStatusText(pt.status)}</span><br />
                  โอกาสฝนตก: <strong>{pt.rainProbability}%</strong><br />
                  ปริมาณฝน: <strong>{pt.rainAmountMm} มม.</strong>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* TOP FLOATING ISLAND */}
      {!isTracking && (
        <div
          style={{
            position: 'absolute',
            top: 'max(16px, env(safe-area-inset-top))',
            left: '16px',
            right: '16px',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(20px)',
              borderRadius: '30px',
              padding: '6px 10px',
              boxShadow: '0 10px 30px rgba(0, 0, 0, 0.1), 0 2px 6px rgba(0, 0, 0, 0.04)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              border: '1px solid rgba(255, 255, 255, 0.8)',
            }}
          >
            <button
              onClick={() => {
                const nextVehicle = vehicleType === 'motorcycle' ? 'car' : 'motorcycle';
                const nextToll = nextVehicle === 'motorcycle';
                const nextHigh = nextVehicle === 'motorcycle';
                setVehicleType(nextVehicle);
                setAvoidTollways(nextToll);
                setAvoidHighways(nextHigh);
                if (data && destination) handleCheckRain(nextVehicle, nextToll, nextHigh);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: vehicleType === 'motorcycle' ? '#ecfdf5' : '#eff6ff',
                color: vehicleType === 'motorcycle' ? '#047857' : '#1d4ed8',
                border: `1.5px solid ${vehicleType === 'motorcycle' ? '#a7f3d0' : '#bfdbfe'}`,
                borderRadius: '20px',
                padding: '6px 12px',
                fontSize: '0.82rem',
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              <Icon
                icon={vehicleType === 'motorcycle' ? 'solar:scooter-bold-duotone' : 'solar:car-bold-duotone'}
                width="18"
                height="18"
              />
              <span>{vehicleType === 'motorcycle' ? 'มอเตอร์ไซค์' : 'รถยนต์'}</span>
            </button>

            <div
              onClick={() => setActiveSheet('LOCATIONS')}
              style={{
                flex: 1,
                minWidth: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 6px',
              }}
            >
              <Icon icon="solar:map-point-bold-duotone" width="18" height="18" style={{ color: destination ? '#ef4444' : '#94a3b8', flexShrink: 0 }} />
              <span
                style={{
                  fontSize: '0.86rem',
                  fontWeight: destination ? 700 : 500,
                  color: destination ? '#0f172a' : '#64748b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {destinationName || 'เลือกจุดหมายปลายทาง...'}
              </span>
            </div>

            <button
              onClick={() => setActiveSheet('LOCATIONS')}
              style={{
                backgroundColor: '#f1f5f9',
                color: '#334155',
                border: 'none',
                borderRadius: '50%',
                width: '36px',
                height: '36px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <Icon icon="solar:magnifer-bold" width="18" height="18" />
            </button>
          </div>
        </div>
      )}

      {/* FLOATING GISTDA FLOOD CONTROLLER */}
      {!isTracking && (
        <div
          style={{
            position: 'absolute',
            top: 'max(84px, env(safe-area-inset-top) + 68px)',
            right: '16px',
            zIndex: 90,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '6px',
          }}
        >
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(16px)',
              borderRadius: '24px',
              padding: '4px 6px 4px 10px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
              border: showFloodLayer ? '1.5px solid #38bdf8' : '1px solid rgba(226, 232, 240, 0.8)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <button
              onClick={() => setShowFloodLayer(!showFloodLayer)}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '0.78rem',
                fontWeight: 700,
                color: showFloodLayer ? '#0284c7' : '#64748b',
                cursor: 'pointer',
                padding: '4px 0',
              }}
            >
              <Icon
                icon={isFloodLoading ? 'solar:refresh-circle-bold' : 'solar:waterdrop-bold-duotone'}
                width="18"
                height="18"
                className={isFloodLoading ? 'animate-spin' : ''}
                style={{ color: showFloodLayer ? '#0284c7' : '#94a3b8' }}
              />
              <span>น้ำท่วม</span>
              {showFloodLayer && floodData?.features && (
                <span
                  style={{
                    backgroundColor: '#e0f2fe',
                    color: '#0369a1',
                    borderRadius: '10px',
                    padding: '1px 6px',
                    fontSize: '0.68rem',
                    fontWeight: 800,
                  }}
                >
                  {floodData.features.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setShowFloodMenu(!showFloodMenu)}
              style={{
                backgroundColor: showFloodMenu ? '#e0f2fe' : '#f1f5f9',
                border: 'none',
                borderRadius: '50%',
                width: '26px',
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: '#0369a1',
              }}
            >
              <Icon icon="solar:alt-arrow-down-bold" width="12" height="12" />
            </button>
          </div>

          {showFloodMenu && (
            <div
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.98)',
                backdropFilter: 'blur(20px)',
                borderRadius: '18px',
                padding: '12px 14px',
                boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
                border: '1px solid #e2e8f0',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                minWidth: '240px',
              }}
            >
              <div style={{ fontSize: '0.8rem', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <Icon icon="solar:satellite-bold-duotone" width="16" height="16" style={{ color: '#0284c7' }} />
                  <span>น้ำท่วม GISTDA ทั้งประเทศ</span>
                </span>
                <span style={{ fontSize: '0.68rem', color: '#0284c7', fontWeight: 700, backgroundColor: '#e0f2fe', padding: '2px 6px', borderRadius: '8px' }}>
                  {floodPeriod === '1day' ? '1 วัน' : 'สะสม 7 วัน'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={() => {
                    fetchFloodData('1day');
                    setShowFloodLayer(true);
                  }}
                  style={{
                    flex: 1,
                    padding: '6px 8px',
                    borderRadius: '8px',
                    border: floodPeriod === '1day' ? '1.5px solid #0284c7' : '1px solid #e2e8f0',
                    backgroundColor: floodPeriod === '1day' ? '#e0f2fe' : '#ffffff',
                    color: floodPeriod === '1day' ? '#0369a1' : '#475569',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  1 วันล่าสุด
                </button>
                <button
                  onClick={() => {
                    fetchFloodData('7days');
                    setShowFloodLayer(true);
                  }}
                  style={{
                    flex: 1,
                    padding: '6px 8px',
                    borderRadius: '8px',
                    border: floodPeriod === '7days' ? '1.5px solid #0284c7' : '1px solid #e2e8f0',
                    backgroundColor: floodPeriod === '7days' ? '#e0f2fe' : '#ffffff',
                    color: floodPeriod === '7days' ? '#0369a1' : '#475569',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  สะสม 7 วัน
                </button>
              </div>

              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#475569', marginTop: '2px' }}>
                ซูมดูพื้นที่น้ำท่วม:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                <button
                  onClick={() => {
                    setShowFloodLayer(true);
                    setMapFlyTarget({ lat: 13.7367, lon: 100.5231, zoom: 6 });
                    setShowFloodMenu(false);
                  }}
                  style={{
                    backgroundColor: '#0284c7',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '6px 8px',
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                >
                  <span>🇹🇭</span> ทั้งประเทศ
                </button>
                <button
                  onClick={() => {
                    setShowFloodLayer(true);
                    setMapFlyTarget({ lat: 14.204, lon: 100.549, zoom: 11 });
                    setShowFloodMenu(false);
                  }}
                  style={{
                    backgroundColor: '#f0f9ff',
                    color: '#0369a1',
                    border: '1px solid #bae6fd',
                    borderRadius: '8px',
                    padding: '6px 8px',
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  📍 ภาคกลาง / อยุธยา
                </button>
                <button
                  onClick={() => {
                    setShowFloodLayer(true);
                    setMapFlyTarget({ lat: 17.005, lon: 99.826, zoom: 10 });
                    setShowFloodMenu(false);
                  }}
                  style={{
                    backgroundColor: '#f0f9ff',
                    color: '#0369a1',
                    border: '1px solid #bae6fd',
                    borderRadius: '8px',
                    padding: '6px 8px',
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  📍 ภาคเหนือ / สุโขทัย
                </button>
                <button
                  onClick={() => {
                    setShowFloodLayer(true);
                    setMapFlyTarget({ lat: 17.146, lon: 103.007, zoom: 10 });
                    setShowFloodMenu(false);
                  }}
                  style={{
                    backgroundColor: '#f0f9ff',
                    color: '#0369a1',
                    border: '1px solid #bae6fd',
                    borderRadius: '8px',
                    padding: '6px 8px',
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  📍 ภาคอีสาน / อุดร
                </button>
              </div>

              <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.3, textAlign: 'center', marginTop: '4px' }}>
                {floodPeriod === '1day' && (!floodData?.features || floodData.features.length === 0)
                  ? 'ยังไม่มีภาพดาวเทียมใหม่ 24 ชม. (สลับไป 7 วันอัตโนมัติ)'
                  : `แสดงผล ${floodData?.features?.length?.toLocaleString() || 0} แปลงทั่วไทย`}
              </div>
            </div>
          )}
        </div>
      )}

      {/* GOOGLE MAPS ROUTE SUMMARY SHEET */}
      {!isTracking && activeRoute && (
        <div
          style={{
            position: 'absolute',
            bottom: 'max(84px, env(safe-area-inset-bottom) + 68px)',
            left: '16px',
            right: '16px',
            zIndex: 110,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              backgroundColor: '#ffffff',
              borderRadius: '24px',
              padding: '16px 18px',
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0,0,0,0.06)',
              border: '1px solid #e2e8f0',
              width: '100%',
              maxWidth: '400px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ width: '36px', height: '4px', backgroundColor: '#e2e8f0', borderRadius: '2px', alignSelf: 'center', marginBottom: '2px' }} />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <span style={{ fontSize: '1.45rem', fontWeight: 900, color: '#1a73e8' }}>
                  {activeRoute.durationFormatted || formatDuration(activeRoute.durationMin)}
                </span>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#5f6368', marginLeft: '6px' }}>
                  ({activeRoute.distanceKm} กม.)
                </span>
              </div>

              <span
                onClick={() => setActiveSheet('SUMMARY')}
                style={{
                  fontSize: '0.74rem',
                  fontWeight: 800,
                  padding: '3px 8px',
                  borderRadius: '12px',
                  backgroundColor: activeRoute.maxRainProbability > 30 ? '#fee2e2' : '#ecfdf5',
                  color: activeRoute.maxRainProbability > 30 ? '#dc2626' : '#059669',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Icon icon={activeRoute.maxRainProbability > 30 ? 'solar:cloud-rain-bold-duotone' : 'solar:sun-2-bold-duotone'} width="14" height="14" />
                {activeRoute.maxRainProbability > 30 ? `ฝน ${activeRoute.maxRainProbability}%` : 'ถนนแห้ง'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.78rem', color: '#4b5563' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700, color: activeRoute.hasTollway ? '#d97706' : '#059669', flexShrink: 0 }}>
                <Icon icon={activeRoute.hasTollway ? 'solar:road-bold-duotone' : 'solar:shield-check-bold'} width="14" height="14" />
                {activeRoute.hasTollway ? `ขึ้นทางด่วน (~ ${activeRoute.tollDistanceKm} กม.)` : 'ไม่ขึ้นทางด่วน (ทางราบ)'}
              </span>

              {/* Drop Option สำหรับเลือกเส้นทาง */}
              {data?.routes && data.routes.length > 1 ? (
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <select
                    value={selectedRouteIndex}
                    onChange={(e) => {
                      const newIdx = Number(e.target.value);
                      setSelectedRouteIndex(newIdx);
                    }}
                    style={{
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      backgroundColor: '#eff6ff',
                      color: '#1d4ed8',
                      border: '1.5px solid #93c5fd',
                      borderRadius: '14px',
                      padding: '4px 26px 4px 10px',
                      fontSize: '0.76rem',
                      fontWeight: 800,
                      cursor: 'pointer',
                      outline: 'none',
                      boxShadow: '0 2px 6px rgba(37,99,235,0.12)',
                    }}
                  >
                    {data.routes.map((rt: any, i: number) => (
                      <option key={`opt-rt-${i}`} value={i}>
                        {rt.name || `เส้นทางที่ ${i + 1}`} ({rt.durationFormatted || rt.durationMin + ' นาที'})
                      </option>
                    ))}
                  </select>
                  <Icon
                    icon="solar:alt-arrow-down-bold"
                    width="12"
                    height="12"
                    style={{
                      position: 'absolute',
                      right: '8px',
                      color: '#1d4ed8',
                      pointerEvents: 'none',
                    }}
                  />
                </div>
              ) : (
                <span style={{ color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  • {activeRoute.name}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                onClick={toggleTracking}
                style={{
                  flex: 1,
                  backgroundColor: '#1a73e8',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '18px',
                  padding: '11px 16px',
                  fontSize: '0.92rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 14px rgba(26,115,232,0.35)',
                }}
              >
                <Icon icon="solar:navigation-bold" width="18" height="18" />
                <span>เริ่มเดินทาง</span>
              </button>

              <button
                onClick={() => setActiveSheet('SUMMARY')}
                style={{
                  backgroundColor: '#f1f5f9',
                  color: '#334155',
                  border: 'none',
                  borderRadius: '18px',
                  padding: '11px 14px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Icon icon="solar:cloud-rain-bold-duotone" width="16" height="16" />
                <span>ดูฝน</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BOTTOM FLOATING ACTION DOCK */}
      {!isTracking && (
        <div
          style={{
            position: 'absolute',
            bottom: 'max(20px, env(safe-area-inset-bottom))',
            left: '16px',
            right: '16px',
            zIndex: 100,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              backgroundColor: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(20px)',
              borderRadius: '36px',
              padding: '8px 16px',
              boxShadow: '0 14px 38px rgba(0, 0, 0, 0.16), 0 3px 8px rgba(0, 0, 0, 0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '14px',
              border: '1px solid rgba(255, 255, 255, 0.8)',
              width: '100%',
              maxWidth: '390px',
            }}
          >
            <button
              onClick={handleGetCurrentLocation}
              disabled={isGpsLoading}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                borderRadius: '50%',
                width: '42px',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: '#3b82f6',
              }}
            >
              <Icon
                icon={isGpsLoading ? 'solar:refresh-circle-bold' : 'solar:gps-bold-duotone'}
                width="24"
                height="24"
                className={isGpsLoading ? 'animate-spin' : ''}
              />
            </button>

            <button
              onClick={() => setActiveSheet(activeSheet === 'TIME' ? 'NONE' : 'TIME')}
              style={{
                backgroundColor: departureOffsetMin > 0 ? '#eff6ff' : 'transparent',
                border: 'none',
                borderRadius: '50%',
                width: '42px',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: departureOffsetMin > 0 ? '#2563eb' : '#64748b',
                position: 'relative',
              }}
            >
              <Icon icon="solar:clock-circle-bold-duotone" width="24" height="24" />
              {departureOffsetMin > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '4px',
                    right: '4px',
                    width: '8px',
                    height: '8px',
                    backgroundColor: '#ef4444',
                    borderRadius: '50%',
                  }}
                />
              )}
            </button>

            <button
              onClick={() => {
                if (!destination) {
                  setActiveSheet('LOCATIONS');
                } else {
                  handleCheckRain(vehicleType, avoidTollways, avoidHighways);
                }
              }}
              disabled={loading}
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)',
                color: '#ffffff',
                border: '3px solid #ffffff',
                boxShadow: '0 8px 24px rgba(244, 63, 94, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: loading ? 'not-allowed' : 'pointer',
                transform: 'translateY(-8px)',
              }}
            >
              <Icon
                icon={loading ? 'solar:refresh-circle-bold' : (destination ? 'solar:radar-2-bold-duotone' : 'solar:map-point-search-bold-duotone')}
                width="28"
                height="28"
                className={loading ? 'animate-spin' : ''}
              />
            </button>

            <button
              onClick={() => setActiveSheet(activeSheet === 'AVOID' ? 'NONE' : 'AVOID')}
              style={{
                backgroundColor: (avoidTollways || avoidHighways) ? '#fef3c7' : 'transparent',
                border: 'none',
                borderRadius: '50%',
                width: '42px',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: (avoidTollways || avoidHighways) ? '#d97706' : '#64748b',
              }}
            >
              <Icon icon="solar:tuning-bold-duotone" width="24" height="24" />
            </button>

            <button
              onClick={toggleTracking}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                borderRadius: '50%',
                width: '42px',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: '#10b981',
              }}
            >
              <Icon icon="solar:compass-bold-duotone" width="24" height="24" />
            </button>
          </div>
        </div>
      )}

      {/* SLIDE-UP MODAL SHEETS */}
      {activeSheet !== 'NONE' && (
        <div
          onClick={() => setActiveSheet('NONE')}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 150,
            backgroundColor: 'rgba(15, 23, 42, 0.35)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            padding: isMobile ? '0' : '24px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#ffffff',
              borderTopLeftRadius: '28px',
              borderTopRightRadius: '28px',
              borderBottomLeftRadius: isMobile ? '0' : '28px',
              borderBottomRightRadius: isMobile ? '0' : '28px',
              width: '100%',
              maxWidth: '440px',
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: '20px 22px 28px 22px',
              boxShadow: '0 -10px 40px rgba(0, 0, 0, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div style={{ width: '40px', height: '4px', backgroundColor: '#e2e8f0', borderRadius: '2px', alignSelf: 'center', marginBottom: '4px' }} />

            {/* SHEET 1: LOCATIONS */}
            {activeSheet === 'LOCATIONS' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon icon="solar:routing-bold-duotone" width="24" height="24" style={{ color: '#2563eb' }} />
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>ค้นหาเส้นทาง</h3>
                  </div>
                  <button
                    onClick={() => setActiveSheet('NONE')}
                    style={{ border: 'none', background: '#f1f5f9', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748b' }}
                  >
                    <Icon icon="solar:close-circle-bold" width="20" height="20" />
                  </button>
                </div>

                <div ref={originInputRef} style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#059669', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Icon icon="solar:map-point-bold-duotone" width="16" height="16" /> จุดเริ่มต้น
                    </label>
                    <span onClick={handleGetCurrentLocation} style={{ fontSize: '0.75rem', color: '#2563eb', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <Icon icon="solar:gps-bold-duotone" width="14" height="14" /> ใช้พิกัดฉัน
                    </span>
                  </div>
                  <input
                    type="text"
                    value={originName}
                    onChange={(e) => { setOriginName(e.target.value); setShowOriginDropdown(true); }}
                    onFocus={() => setShowOriginDropdown(true)}
                    placeholder="ค้นหาจุดเริ่มต้น..."
                    style={{ width: '100%', padding: '10px 12px', borderRadius: '12px', border: '1.5px solid #cbd5e1', fontSize: '0.9rem', boxSizing: 'border-box' }}
                  />
                  {showOriginDropdown && originSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, backgroundColor: '#ffffff', borderRadius: '10px', boxShadow: '0 6px 20px rgba(0,0,0,0.15)', marginTop: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                      {originSuggestions.map((item) => (
                        <div
                          key={item.place_id}
                          onClick={() => {
                            setOrigin({ lat: parseFloat(item.lat), lon: parseFloat(item.lon) });
                            setOriginName(item.display_name.split(',').slice(0, 3).join(', '));
                            setShowOriginDropdown(false);
                          }}
                          style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontSize: '0.82rem' }}
                        >
                          {item.display_name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button
                    onClick={handleSwapLocations}
                    style={{
                      backgroundColor: '#f1f5f9',
                      border: 'none',
                      borderRadius: '20px',
                      padding: '5px 14px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: '#475569',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <Icon icon="solar:transfer-vertical-bold" width="16" height="16" /> สลับต้นทาง - ปลายทาง
                  </button>
                </div>

                <div ref={destInputRef} style={{ position: 'relative' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                    <Icon icon="solar:flag-bold-duotone" width="16" height="16" /> ปลายทาง (กรุณาเลือก)
                  </label>
                  <input
                    type="text"
                    value={destinationName}
                    onChange={(e) => { setDestinationName(e.target.value); setShowDestDropdown(true); }}
                    onFocus={() => setShowDestDropdown(true)}
                    placeholder="พิมพ์จุดหมายปลายทาง เช่น สยาม, ฟิวเจอร์พาร์ค..."
                    autoFocus={!destination}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: '12px',
                      border: destination ? '1.5px solid #cbd5e1' : '2px solid #f43f5e',
                      fontSize: '0.9rem',
                      boxSizing: 'border-box',
                    }}
                  />
                  {showDestDropdown && destSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, backgroundColor: '#ffffff', borderRadius: '10px', boxShadow: '0 6px 20px rgba(0,0,0,0.15)', marginTop: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                      {destSuggestions.map((item) => (
                        <div
                          key={item.place_id}
                          onClick={() => {
                            const newLat = parseFloat(item.lat);
                            const newLon = parseFloat(item.lon);
                            const shortName = item.display_name.split(',').slice(0, 3).join(', ');
                            setDestination({ lat: newLat, lon: newLon });
                            setDestinationName(shortName);
                            setShowDestDropdown(false);
                            handleCheckRain(vehicleType, avoidTollways, avoidHighways, { lat: newLat, lon: newLon, name: shortName });
                          }}
                          style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontSize: '0.82rem' }}
                        >
                          {item.display_name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ fontSize: '0.74rem', color: '#64748b', fontWeight: 700, marginBottom: '6px' }}>
                    ปลายทางยอดนิยม:
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {[
                      { name: 'ฟิวเจอร์พาร์ค รังสิต', lat: 13.9892, lon: 100.6177 },
                      { name: 'สยามพารากอน', lat: 13.7466, lon: 100.5348 },
                      { name: 'สนามบินดอนเมือง', lat: 13.9132, lon: 100.6042 },
                      { name: 'สนามบินสุวรรณภูมิ', lat: 13.6900, lon: 100.7501 },
                      { name: 'บางแสน ชลบุรี', lat: 13.2849, lon: 100.9152 },
                    ].map((dest) => (
                      <button
                        key={dest.name}
                        onClick={() => selectQuickDestination(dest)}
                        style={{
                          backgroundColor: '#f8fafc',
                          border: '1px solid #e2e8f0',
                          borderRadius: '16px',
                          padding: '5px 10px',
                          fontSize: '0.76rem',
                          fontWeight: 600,
                          color: '#334155',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <Icon icon="solar:map-point-wave-bold" width="13" height="13" style={{ color: '#2563eb' }} />
                        {dest.name}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => handleCheckRain(vehicleType, avoidTollways, avoidHighways)}
                  disabled={loading || !destination}
                  style={{
                    backgroundColor: destination ? '#2563eb' : '#94a3b8',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '14px',
                    padding: '12px',
                    fontSize: '0.95rem',
                    fontWeight: 800,
                    cursor: destination ? 'pointer' : 'not-allowed',
                    marginTop: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  <Icon icon="solar:radar-2-bold" width="20" height="20" />
                  {destination ? 'สแกนสภาพอากาศเส้นทางนี้' : 'กรุณาเลือกปลายทางก่อน'}
                </button>
              </>
            )}

            {/* SHEET 2: TIME */}
            {activeSheet === 'TIME' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon icon="solar:clock-circle-bold-duotone" width="24" height="24" style={{ color: '#2563eb' }} />
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>เวลาออกเดินทางล่วงหน้า</h3>
                  </div>
                  <button
                    onClick={() => setActiveSheet('NONE')}
                    style={{ border: 'none', background: '#f1f5f9', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748b' }}
                  >
                    <Icon icon="solar:close-circle-bold" width="20" height="20" />
                  </button>
                </div>

                <div style={{ backgroundColor: '#eff6ff', padding: '12px', borderRadius: '14px', border: '1px solid #bfdbfe', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>เวลาออกเดินทางเป้าหมาย</div>
                  <div style={{ fontSize: '1.35rem', fontWeight: 900, color: '#1d4ed8', marginTop: '2px' }}>
                    {getDepartureTimeLabel(departureOffsetMin)}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                  {[
                    { label: 'ตอนนี้', min: 0 },
                    { label: '+30 นาที', min: 30 },
                    { label: '+1 ชม.', min: 60 },
                    { label: '+1.5 ชม.', min: 90 },
                    { label: '+2 ชม.', min: 120 },
                    { label: '+3 ชม.', min: 180 },
                  ].map((preset) => (
                    <button
                      key={preset.min}
                      onClick={() => {
                        setDepartureOffsetMin(preset.min);
                        if (data && destination) handleCheckRain(vehicleType, avoidTollways, avoidHighways);
                      }}
                      style={{
                        padding: '8px 4px',
                        borderRadius: '10px',
                        border: departureOffsetMin === preset.min ? '2px solid #2563eb' : '1px solid #e2e8f0',
                        backgroundColor: departureOffsetMin === preset.min ? '#eff6ff' : '#ffffff',
                        color: departureOffsetMin === preset.min ? '#1d4ed8' : '#334155',
                        fontWeight: 700,
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: '6px' }}>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    step={15}
                    value={departureOffsetMin}
                    onChange={(e) => setDepartureOffsetMin(parseInt(e.target.value, 10))}
                    style={{ width: '100%', height: '6px', accentColor: '#2563eb', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#64748b' }}>
                    <span>ตอนนี้</span>
                    <span>+6 ชม.</span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    if (destination) handleCheckRain(vehicleType, avoidTollways, avoidHighways);
                    setActiveSheet('NONE');
                  }}
                  style={{ backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '12px', padding: '10px', fontWeight: 800, cursor: 'pointer' }}
                >
                  อัปเดตเส้นทาง
                </button>
              </>
            )}

            {/* SHEET 3: AVOID */}
            {activeSheet === 'AVOID' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon icon="solar:tuning-bold-duotone" width="24" height="24" style={{ color: '#2563eb' }} />
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>การเลี่ยงเส้นทาง</h3>
                  </div>
                  <button
                    onClick={() => setActiveSheet('NONE')}
                    style={{ border: 'none', background: '#f1f5f9', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748b' }}
                  >
                    <Icon icon="solar:close-circle-bold" width="20" height="20" />
                  </button>
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    borderRadius: '14px',
                    backgroundColor: avoidTollways ? '#fef2f2' : '#f8fafc',
                    border: `1.5px solid ${avoidTollways ? '#fca5a5' : '#e2e8f0'}`,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: avoidTollways ? '#fee2e2' : '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon icon="solar:shield-cross-bold-duotone" width="20" height="20" style={{ color: avoidTollways ? '#ef4444' : '#64748b' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: avoidTollways ? '#b91c1c' : '#1e293b' }}>
                        เลี่ยงทางด่วน / โทลล์เวย์
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                        {avoidTollways ? 'วิ่งเฉพาะทางราบ ไม่ขึ้นทางด่วน' : 'อนุญาตให้ขึ้นทางด่วนได้'}
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={avoidTollways}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setAvoidTollways(next);
                      if (data && destination) handleCheckRain(vehicleType, next, avoidHighways);
                    }}
                    style={{ width: '18px', height: '18px', accentColor: '#ef4444' }}
                  />
                </label>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    borderRadius: '14px',
                    backgroundColor: avoidHighways ? '#fffbeb' : '#f8fafc',
                    border: `1.5px solid ${avoidHighways ? '#fde68a' : '#e2e8f0'}`,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: avoidHighways ? '#fef3c7' : '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon icon="solar:signpost-bold-duotone" width="20" height="20" style={{ color: avoidHighways ? '#d97706' : '#64748b' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: avoidHighways ? '#b45309' : '#1e293b' }}>
                        เลี่ยงทางหลวง (Highways / มอเตอร์เวย์)
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                        {avoidHighways ? 'เลี่ยงถนนหลักความเร็วสูง' : 'วิ่งถนนทางหลวงได้ตามปกติ'}
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={avoidHighways}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setAvoidHighways(next);
                      if (data && destination) handleCheckRain(vehicleType, avoidTollways, next);
                    }}
                    style={{ width: '18px', height: '18px', accentColor: '#f59e0b' }}
                  />
                </label>

                <button
                  onClick={() => {
                    if (destination) handleCheckRain(vehicleType, avoidTollways, avoidHighways);
                    setActiveSheet('NONE');
                  }}
                  style={{ backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '12px', padding: '10px', fontWeight: 800, cursor: 'pointer' }}
                >
                  ตกลง
                </button>
              </>
            )}

            {/* SHEET 4: SUMMARY */}
            {activeSheet === 'SUMMARY' && data && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon icon="solar:cloud-rain-bold-duotone" width="24" height="24" style={{ color: '#2563eb' }} />
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>รายงานสภาพอากาศเส้นทาง</h3>
                  </div>
                  <button
                    onClick={() => setActiveSheet('NONE')}
                    style={{ border: 'none', background: '#f1f5f9', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748b' }}
                  >
                    <Icon icon="solar:close-circle-bold" width="20" height="20" />
                  </button>
                </div>

                <div
                  style={{
                    padding: '14px',
                    borderRadius: '16px',
                    backgroundColor: '#f8fafc',
                    borderLeft: `6px solid ${getStatusColor(activeRoute ? activeRoute.status : data.summary.status)}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '1.05rem', fontWeight: 900, color: getStatusColor(activeRoute ? activeRoute.status : data.summary.status) }}>
                      {getStatusText(activeRoute ? activeRoute.status : data.summary.status)}
                    </span>
                    <span style={{ fontSize: '0.76rem', fontWeight: 800, color: '#334155', backgroundColor: '#e2e8f0', padding: '3px 8px', borderRadius: '10px' }}>
                      ฝนสูงสุด {activeRoute ? activeRoute.maxRainProbability : data.summary.maxRainProbability}%
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                    <div style={{ backgroundColor: 'white', padding: '8px 10px', borderRadius: '8px' }}>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>ระยะทาง</div>
                      <div style={{ fontSize: '1rem', fontWeight: 800 }}>{activeRoute ? activeRoute.distanceKm : data.summary.totalDistanceKm} กม.</div>
                    </div>
                    <div style={{ backgroundColor: 'white', padding: '8px 10px', borderRadius: '8px' }}>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>เวลาเดินทาง</div>
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2563eb' }}>
                        {activeRoute?.durationFormatted || formatDuration(activeRoute ? activeRoute.durationMin : data.summary.totalDurationMin)}
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: activeRoute?.hasTollway ? '#b45309' : '#047857', fontWeight: 700 }}>
                    {activeRoute?.hasTollway ? `🚗 ขึ้นทางด่วน (~ ${activeRoute.tollDistanceKm} กม.)` : '🚫 ทางราบล้วน ไม่ขึ้นทางด่วน'}
                  </div>

                  <div style={{ marginTop: '8px', fontSize: '0.82rem', color: '#334155', lineHeight: '1.4' }}>
                    💡 <strong>คำแนะนำ:</strong> {activeRoute ? activeRoute.recommendation : data.summary.recommendation}
                  </div>
                </div>

                <div style={{ fontSize: '0.84rem', fontWeight: 800, color: '#1e293b', marginTop: '6px' }}>
                  จุดตรวจสภาพอากาศตลอดสาย ({activeRoute?.checkpoints?.length || data.checkpoints.length} จุด)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                  {(activeRoute?.checkpoints || data.checkpoints).map((pt) => (
                    <div
                      key={pt.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: '8px',
                        backgroundColor: '#f8fafc',
                        fontSize: '0.78rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: getStatusColor(pt.status) }} />
                        <span>จุดที่ {pt.id} {pt.etaTime ? `(~ ${pt.etaTime} น.)` : ''}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: getStatusColor(pt.status) }}>
                        {pt.rainProbability > 0 ? `ฝน ${pt.rainProbability}%` : 'แห้ง'}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* DRIVER HUD */}
      {isTracking && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 'max(14px, env(safe-area-inset-top))',
              left: '14px',
              right: '14px',
              zIndex: 1000,
              backgroundColor: 'rgba(15, 23, 42, 0.92)',
              backdropFilter: 'blur(16px)',
              borderRadius: '24px',
              padding: '10px 16px',
              boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              color: '#ffffff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
              <span style={{ fontSize: '1.9rem', fontWeight: 900, color: '#38bdf8', lineHeight: 1 }}>
                {liveLocation?.speed != null ? liveLocation.speed : '0'}
              </span>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>กม./ชม.</span>
            </div>

            <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
              <span
                style={{
                  backgroundColor: data ? getStatusColor(activeRoute ? activeRoute.status : data.summary.status) : '#2563eb',
                  color: '#ffffff',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  fontSize: '0.78rem',
                  fontWeight: 800,
                }}
              >
                {data ? getStatusText(activeRoute ? activeRoute.status : data.summary.status) : 'กำลังนำทาง'}
              </span>
              <div style={{ fontSize: '0.74rem', color: '#cbd5e1', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {destinationName} {activeRoute ? `(${activeRoute.distanceKm} กม.)` : ''}
              </div>
            </div>

            <button
              onClick={toggleTracking}
              style={{
                backgroundColor: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: '12px',
                padding: '8px 12px',
                fontSize: '0.8rem',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <Icon icon="solar:stop-circle-bold-duotone" width="16" height="16" /> หยุด
            </button>
          </div>

          <div
            style={{
              position: 'absolute',
              bottom: 'max(20px, env(safe-area-inset-bottom))',
              left: '14px',
              right: '14px',
              zIndex: 1000,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '10px',
              pointerEvents: 'none',
            }}
          >
            {/* ปุ่มดึงกลับมาที่ตัวเรา (Re-center to POV) - แสดงเมื่ออยู่ในโหมด POV แต่ผู้ใช้เลื่อนแผนที่ออกไป */}
            {(povMode === 'DRIVER_CLOSE' || povMode === 'DRIVER_FAR') && !autoFollow && (
              <button
                onClick={() => {
                  setAutoFollow(true);
                  setRecenterTrigger((c) => c + 1);
                }}
                style={{
                  pointerEvents: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  border: '2px solid rgba(255, 255, 255, 0.4)',
                  borderRadius: '24px',
                  padding: '9px 18px',
                  fontSize: '0.84rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  boxShadow: '0 6px 20px rgba(2, 132, 199, 0.45)',
                  animation: 'pulse 1.5s infinite',
                }}
              >
                <Icon icon="solar:target-bold" width="18" height="18" />
                <span>ดึงกลับมาที่ตัวเรา (ติดตามต่อ)</span>
              </button>
            )}

            {/* แถบเลือกโหมดมุมมอง (View Mode Selector) */}
            <div
              style={{
                pointerEvents: 'auto',
                display: 'inline-flex',
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                backdropFilter: 'blur(16px)',
                border: '1.5px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '30px',
                padding: '4px',
                boxShadow: '0 8px 30px rgba(0, 0, 0, 0.45)',
                gap: '4px',
              }}
            >
              {/* ตัวเลือกที่ 1: POV ใกล้ (18x) */}
              <button
                onClick={() => {
                  setPovMode('DRIVER_CLOSE');
                  setAutoFollow(true);
                  setRecenterTrigger((c) => c + 1);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 15px',
                  borderRadius: '24px',
                  fontSize: '0.82rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  border: 'none',
                  backgroundColor: povMode === 'DRIVER_CLOSE' ? '#2563eb' : 'transparent',
                  color: povMode === 'DRIVER_CLOSE' ? '#ffffff' : '#94a3b8',
                  boxShadow: povMode === 'DRIVER_CLOSE' ? '0 4px 16px rgba(37, 99, 235, 0.55)' : 'none',
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <Icon
                  icon={vehicleType === 'motorcycle' ? 'solar:scooter-bold-duotone' : 'solar:car-bold-duotone'}
                  width="17"
                  height="17"
                />
                <span>POV ใกล้</span>
                {povMode === 'DRIVER_CLOSE' && autoFollow && (
                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: '#38bdf8',
                      boxShadow: '0 0 6px #38bdf8',
                    }}
                  />
                )}
              </button>

              {/* ตัวเลือกที่ 2: วิวบน (ซูมไกล 14x) */}
              <button
                onClick={() => {
                  setPovMode('DRIVER_FAR');
                  setAutoFollow(true);
                  setRecenterTrigger((c) => c + 1);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 15px',
                  borderRadius: '24px',
                  fontSize: '0.82rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  border: 'none',
                  backgroundColor: povMode === 'DRIVER_FAR' ? '#2563eb' : 'transparent',
                  color: povMode === 'DRIVER_FAR' ? '#ffffff' : '#94a3b8',
                  boxShadow: povMode === 'DRIVER_FAR' ? '0 4px 16px rgba(37, 99, 235, 0.55)' : 'none',
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <Icon icon="solar:satellite-bold-duotone" width="17" height="17" />
                <span>วิวบน (ซูมไกล)</span>
                {povMode === 'DRIVER_FAR' && autoFollow && (
                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: '#38bdf8',
                      boxShadow: '0 0 6px #38bdf8',
                    }}
                  />
                )}
              </button>

              {/* ตัวเลือกที่ 3: ภาพรวมเส้นทาง */}
              <button
                onClick={() => {
                  setPovMode('OVERVIEW');
                  setAutoFollow(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 15px',
                  borderRadius: '24px',
                  fontSize: '0.82rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  border: 'none',
                  backgroundColor: povMode === 'OVERVIEW' ? '#2563eb' : 'transparent',
                  color: povMode === 'OVERVIEW' ? '#ffffff' : '#94a3b8',
                  boxShadow: povMode === 'OVERVIEW' ? '0 4px 16px rgba(37, 99, 235, 0.55)' : 'none',
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <Icon icon="solar:map-bold-duotone" width="17" height="17" />
                <span>ภาพรวม</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* RADAR SCANNING ANIMATION OVERLAY */}
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3000,
            backgroundColor: 'rgba(15, 23, 42, 0.68)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            color: '#ffffff',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '180px',
              height: '180px',
              borderRadius: '50%',
              border: '2px solid rgba(56, 189, 248, 0.45)',
              boxShadow: '0 0 35px rgba(14, 165, 233, 0.4), inset 0 0 35px rgba(14, 165, 233, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              background: 'radial-gradient(circle, rgba(14, 165, 233, 0.2) 0%, rgba(15, 23, 42, 0.85) 100%)',
            }}
          >
            <div style={{ position: 'absolute', width: '120px', height: '120px', borderRadius: '50%', border: '1px dashed rgba(56, 189, 248, 0.4)' }} />
            <div style={{ position: 'absolute', width: '60px', height: '60px', borderRadius: '50%', border: '1px solid rgba(56, 189, 248, 0.5)' }} />
            <div style={{ position: 'absolute', width: '100%', height: '1px', background: 'rgba(56, 189, 248, 0.3)' }} />
            <div style={{ position: 'absolute', height: '100%', width: '1px', background: 'rgba(56, 189, 248, 0.3)' }} />

            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: 'conic-gradient(from 0deg, rgba(56, 189, 248, 0) 0deg, rgba(56, 189, 248, 0) 260deg, rgba(56, 189, 248, 0.65) 360deg)',
                animation: 'radarSpin 1.6s linear infinite',
              }}
            />

            <div
              style={{
                position: 'relative',
                width: '46px',
                height: '46px',
                borderRadius: '50%',
                backgroundColor: '#0284c7',
                boxShadow: '0 0 24px #38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px solid #ffffff',
              }}
            >
              <Icon icon="solar:radar-2-bold" width="26" height="26" className="animate-spin text-white" />
            </div>
          </div>

          <div style={{ marginTop: '24px', textAlign: 'center', maxWidth: '320px' }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#f8fafc', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#38bdf8' }} />
              <span>กำลังสแกนสภาพอากาศเส้นทาง</span>
            </div>
            <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: '6px', lineHeight: 1.4 }}>
              เชื่อมต่อเรดาร์ฝนและดาวเทียม GISTDA ตรวจสอบสภาพถนนตลอดแนว...
            </div>

            <div
              style={{
                marginTop: '16px',
                width: '210px',
                height: '5px',
                backgroundColor: 'rgba(255, 255, 255, 0.15)',
                borderRadius: '3px',
                overflow: 'hidden',
                margin: '16px auto 0 auto',
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: 'linear-gradient(90deg, #38bdf8, #818cf8, #38bdf8)',
                  backgroundSize: '200% 100%',
                  animation: 'scanProgressAnim 1.6s ease-in-out infinite',
                  borderRadius: '3px',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;