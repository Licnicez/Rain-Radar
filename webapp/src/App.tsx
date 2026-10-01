import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface Checkpoint {
  id: number;
  lat: number;
  lon: number;
  etaTime?: string;
  rainProbability: number;
  rainAmountMm: number;
  status: 'SAFE' | 'WARNING' | 'DANGER';
}

interface RouteAnalysis {
  summary: {
    status: 'SAFE' | 'WARNING' | 'DANGER';
    departureTime?: string;
    departureOffsetMin?: number;
    totalDistanceKm: string;
    totalDurationMin: number;
    totalCheckpoints: number;
    rainPointsCount: number;
    maxRainProbability: number;
    recommendation: string;
  };
  routeGeometry: {
    coordinates: [number, number][]; // [lon, lat]
  };
  checkpoints: Checkpoint[];
}

interface PlaceSuggestion {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
}

// ฟังก์ชันคำนวณทิศทางการหันหน้า (Bearing 0-360 องศา) จาก 2 พิกัดล่าสุด
function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(((lon2 - lon1) * Math.PI) / 180);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

// คำนวณระยะห่างระหว่างจุด (Haversine formula - กิโลเมตร)
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

// ซอยจุดพิกัดตามระยะห่าง (km)
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

// วิเคราะห์เส้นทางและสภาพอากาศโดยตรงบนเบราว์เซอร์ผู้ใช้ (Client-Side Fallback)
// ช่วยป้องกันปัญหา Render Free Tier ติด Rate Limit 429 หรือ Cold Start หลับ
async function analyzeRouteClientSide(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  sampleIntervalKm = 4,
  departureOffsetMin = 0
): Promise<RouteAnalysis> {
  // 1. ดึงเส้นทางจาก OSRM
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

  const coordinates: { lat: number; lon: number }[] = route.geometry.coordinates.map(
    ([lon, lat]: [number, number]) => ({ lat, lon })
  );
  const checkpoints = sampleRoutePoints(coordinates, sampleIntervalKm);
  const totalDurationMin = Math.round(route.duration / 60);

  // 2. คำนวณเวลาออกเดินทางจริง
  const departureDate = new Date(Date.now() + departureOffsetMin * 60 * 1000);
  const departureTimeFormatted = `${String(departureDate.getHours()).padStart(2, '0')}:${String(
    departureDate.getMinutes()
  ).padStart(2, '0')}`;

  // 3. ดึงสภาพอากาศจาก Open-Meteo แบบ Batch
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

      // คำนวณเวลาที่คาดว่าจะเดินทางไปถึงจุดตรวจนี้ (ETA)
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

      const rainProb =
        hourly.precipitation_probability && hourly.precipitation_probability[targetHourIdx] != null
          ? hourly.precipitation_probability[targetHourIdx]
          : 0;
      const rainAmount =
        hourly.rain && hourly.rain[targetHourIdx] != null ? hourly.rain[targetHourIdx] : 0;

      let status: 'SAFE' | 'WARNING' | 'DANGER' = 'SAFE';
      if (rainProb >= 50 || rainAmount >= 1.0) {
        status = 'DANGER';
      } else if (rainProb >= 25 || rainAmount > 0) {
        status = 'WARNING';
      }

      const etaFormatted = `${String(etaDate.getHours()).padStart(2, '0')}:${String(
        etaDate.getMinutes()
      ).padStart(2, '0')}`;

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

  // 4. ประเมินผลสรุปความเสี่ยง
  const rainPoints = allResults.filter((p) => p.status !== 'SAFE');
  const maxProb = Math.max(...allResults.map((p) => p.rainProbability), 0);

  let overallStatus: 'SAFE' | 'WARNING' | 'DANGER' = 'SAFE';
  let recommendation = `ออกเดินทางเวลา ${departureTimeFormatted} น. ถนนแห้ง ปลอดภัยตลอดสาย ขี่กลับได้สบายครับ`;

  if (allResults.some((p) => p.status === 'DANGER')) {
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
      totalCheckpoints: allResults.length,
      rainPointsCount: rainPoints.length,
      maxRainProbability: maxProb,
      recommendation,
    },
    routeGeometry: route.geometry,
    checkpoints: allResults,
  };
}


// สร้างไอคอนรูปรถ/ลูกศรนำทางแบบหมุนได้ตาม coords.heading สไตล์ Google Maps
const createVehicleNavIcon = (heading: number | null) => {
  const rotation = heading !== null && !isNaN(heading) ? Math.round(heading) : 0;
  return L.divIcon({
    className: 'nav-vehicle-marker',
    html: `
      <div style="position: relative; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;">
        <!-- วงแหวนคลื่นเรดาร์กระพริบ -->
        <div style="position: absolute; width: 44px; height: 44px; border-radius: 50%; background: rgba(37,99,235,0.25); animation: navPulse 2s ease-out infinite;"></div>
        <!-- ลูกศรหน้ารถ หมุนตาม Heading -->
        <div style="transform: rotate(${rotation}deg); transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1); width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.4));">
          <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
            <path d="M16 2 L29 27 L16 21 L3 27 Z" fill="#2563eb" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
            <circle cx="16" cy="15" r="3.5" fill="#38bdf8"/>
          </svg>
        </div>
      </div>
    `,
    iconSize: [48, 48],
    iconAnchor: [24, 24],
  });
};

// ควบคุมกล้องแผนที่ให้ติดตามหน้ารถแบบ Real-time และปรับ POV (Driver POV Zoom 17.5 vs Route Overview)
function NavigationFollower({
  isTracking,
  autoFollow,
  setAutoFollow,
  liveLocation,
  povMode,
  routeCoords,
}: {
  isTracking: boolean;
  autoFollow: boolean;
  setAutoFollow: (val: boolean) => void;
  liveLocation: { lat: number; lon: number } | null;
  povMode: 'DRIVER' | 'OVERVIEW';
  routeCoords: [number, number][];
}) {
  const map = useMap();

  // ดักจับเมื่อผู้ใช้เอานิ้วเลื่อนแผนที่ด้วยตนเอง ให้หยุด auto-follow ชั่วคราว
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

  // ซูมเปลี่ยน POV เมื่อเริ่มนำทาง หรือกดเปลี่ยนปุ่ม POV
  useEffect(() => {
    if (!isTracking) return;

    if (povMode === 'DRIVER') {
      if (liveLocation) {
        map.flyTo([liveLocation.lat, liveLocation.lon], 17.5, {
          animate: true,
          duration: 1.0,
        });
      }
    } else if (povMode === 'OVERVIEW') {
      if (routeCoords && routeCoords.length > 0) {
        map.fitBounds(routeCoords, {
          padding: [50, 50],
          maxZoom: 15,
          animate: true,
        });
      }
    }
  }, [isTracking, povMode]);

  // ติดตามตำแหน่งรถอย่างต่อเนื่องตามโหมด POV
  useEffect(() => {
    if (isTracking && autoFollow && liveLocation) {
      if (povMode === 'DRIVER') {
        const currentZoom = map.getZoom();
        if (currentZoom < 16) {
          map.setView([liveLocation.lat, liveLocation.lon], 17.5, {
            animate: true,
            duration: 0.6,
          });
        } else {
          map.panTo([liveLocation.lat, liveLocation.lon], {
            animate: true,
            duration: 0.8,
            easeLinearity: 0.25,
          });
        }
      }
    }
  }, [isTracking, autoFollow, liveLocation?.lat, liveLocation?.lon, povMode, map]);

  return null;
}

// ควบคุมมุมมองและการซูมของแผนที่ (Center, Fit Bounds และ Invalidate Size)
function MapController({
  origin,
  destination,
  routeCoords,
  isTracking,
}: {
  origin: { lat: number; lon: number } | null;
  destination: { lat: number; lon: number } | null;
  routeCoords: [number, number][];
  isTracking: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    map.invalidateSize();
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 250);
    return () => clearTimeout(timer);
  }, [map, isTracking]);

  useEffect(() => {
    // ถ้ากำลังอยู่ในโหมดติดตามหน้ารถสด จะปล่อยให้ NavigationFollower เป็นตัวคุมกล้อง
    if (isTracking) return;

    if (routeCoords && routeCoords.length > 0) {
      map.fitBounds(routeCoords, { padding: [40, 40], maxZoom: 14 });
    } else if (origin && destination && (origin.lat !== destination.lat || origin.lon !== destination.lon)) {
      map.fitBounds(
        [
          [origin.lat, origin.lon],
          [destination.lat, destination.lon],
        ],
        { padding: [50, 50], maxZoom: 14 }
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

  // ตรวจจับขนาดหน้าจอ Mobile (ความกว้าง <= 768px ถือเป็นมือถือ)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);
  const [isDrawerCollapsed, setIsDrawerCollapsed] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // พิกัดเริ่มต้น: จตุจักร -> ฟิวเจอร์พาร์ครังสิต
  const [origin, setOrigin] = useState({ lat: 13.8027, lon: 100.5539 });
  const [originName, setOriginName] = useState('BTS หมอชิต / จตุจักร');

  const [destination, setDestination] = useState({ lat: 13.9892, lon: 100.6177 });
  const [destinationName, setDestinationName] = useState('ฟิวเจอร์พาร์ค รังสิต');

  // แถบเลื่อนเวลาล่วงหน้า (Departure Time Slider) - หน่วยเป็นนาที (0 = ตอนนี้)
  const [departureOffsetMin, setDepartureOffsetMin] = useState(0);

  // ================= ระบบ Live Tracking & Navigation (Google Maps Style) =================
  const [isTracking, setIsTracking] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [povMode, setPovMode] = useState<'DRIVER' | 'OVERVIEW'>('DRIVER');
  const [liveLocation, setLiveLocation] = useState<{
    lat: number;
    lon: number;
    heading: number | null;
    speed: number | null;
    accuracy: number;
  } | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const prevLocationRef = useRef<{ lat: number; lon: number; heading: number | null } | null>(null);

  // ฟังก์ชันเริ่ม / หยุดการติดตามตำแหน่ง GPS แบบ Real-time (watchPosition)
  const toggleTracking = () => {
    if (isTracking) {
      // หยุดติดตาม
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setIsTracking(false);
    } else {
      // เริ่มดักจับตำแหน่งสด
      if (!navigator.geolocation) {
        alert('เบราว์เซอร์ของคุณไม่รองรับการดักจับตำแหน่ง GPS แบบ Real-time');
        return;
      }

      setIsTracking(true);
      setAutoFollow(true);
      setPovMode('DRIVER');
      if (isMobile) {
        setIsDrawerCollapsed(true);
      }

      // ถ้ายังไม่มีข้อมูลเส้นทาง ให้สแกนเส้นทางให้อัตโนมัติ
      if (!data) {
        handleCheckRain();
      }

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude, heading, speed, accuracy } = pos.coords;
          let calculatedHeading = heading;

          // กรณีที่เครื่องอยู่กับที่หรือไม่ได้ค่า heading จากเซ็นเซอร์ ให้คำนวณมุม Bearing จากพิกัดเดิม
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

          const speedKmh = speed !== null && !isNaN(speed) && speed > 0 ? Math.round(speed * 3.6) : null;

          const updated = {
            lat: latitude,
            lon: longitude,
            heading: calculatedHeading,
            speed: speedKmh,
            accuracy: Math.round(accuracy),
          };

          prevLocationRef.current = updated;
          setLiveLocation(updated);

          // อัปเดตจุดเริ่มต้นตามตำแหน่งปัจจุบันอัตโนมัติ
          setOrigin({ lat: latitude, lon: longitude });
          setOriginName('📍 ตำแหน่งสดของคุณ (Live GPS)');
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

  // เคลียร์ watchPosition เมื่อออกจากหน้าเว็บ
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  // สถานะ Geocoding Search
  const [originSuggestions, setOriginSuggestions] = useState<PlaceSuggestion[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isSearchingOrigin, setIsSearchingOrigin] = useState(false);
  const [isSearchingDest, setIsSearchingDest] = useState(false);
  const [showOriginDropdown, setShowOriginDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);

  // สถานะ GPS สำหรับกดครั้งเดียว
  const [isGpsLoading, setIsGpsLoading] = useState(false);
  const [showManualCoords, setShowManualCoords] = useState(false);

  const originInputRef = useRef<HTMLDivElement>(null);
  const destInputRef = useRef<HTMLDivElement>(null);

  // คำนวณข้อความเวลาออกเดินทาง เช่น "ตอนนี้ (21:05 น.)"
  const getDepartureTimeLabel = (offsetMinutes: number) => {
    const targetDate = new Date(Date.now() + offsetMinutes * 60 * 1000);
    const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;

    if (offsetMinutes === 0) {
      return `ตอนนี้ (${timeStr} น.)`;
    }

    const hours = Math.floor(offsetMinutes / 60);
    const mins = offsetMinutes % 60;
    let offsetStr = 'อีก ';
    if (hours > 0) offsetStr += `${hours} ชม. `;
    if (mins > 0) offsetStr += `${mins} นาที `;
    return `${offsetStr}(${timeStr} น.)`;
  };

  // ค้นหาสถานที่ผ่าน Nominatim OpenStreetMap
  const searchPlaces = async (query: string): Promise<PlaceSuggestion[]> => {
    if (!query || query.trim().length < 2) return [];
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        query.trim()
      )}&limit=5&countrycodes=th&addressdetails=1`;
      const res = await fetch(url, {
        headers: { 'Accept-Language': 'th,en' },
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  };

  // Debounced Search Origin
  useEffect(() => {
    if (!showOriginDropdown) return;
    const timer = setTimeout(async () => {
      if (originName && originName.length >= 2 && !originName.startsWith('📍')) {
        setIsSearchingOrigin(true);
        const results = await searchPlaces(originName);
        setOriginSuggestions(results);
        setIsSearchingOrigin(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [originName, showOriginDropdown]);

  // Debounced Search Destination
  useEffect(() => {
    if (!showDestDropdown) return;
    const timer = setTimeout(async () => {
      if (destinationName && destinationName.length >= 2) {
        setIsSearchingDest(true);
        const results = await searchPlaces(destinationName);
        setDestSuggestions(results);
        setIsSearchingDest(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [destinationName, showDestDropdown]);

  // คลิกนอก Dropdown เพื่อปิด
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (originInputRef.current && !originInputRef.current.contains(e.target as Node)) {
        setShowOriginDropdown(false);
      }
      if (destInputRef.current && !destInputRef.current.contains(e.target as Node)) {
        setShowDestDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ดึงพิกัดปัจจุบันครั้งเดียวด้วย getCurrentPosition
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
        setOriginName('📍 ตำแหน่งปัจจุบันของคุณ');
        setShowOriginDropdown(false);
        setIsGpsLoading(false);

        try {
          const revUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`;
          const res = await fetch(revUrl, { headers: { 'Accept-Language': 'th,en' } });
          const revData = await res.json();
          if (revData && revData.display_name) {
            const shortName = revData.display_name.split(',').slice(0, 3).join(', ');
            setOriginName(`📍 ${shortName}`);
          }
        } catch {
          // fallback
        }
      },
      (err) => {
        setIsGpsLoading(false);
        let errorMsg = 'ไม่สามารถดึงตำแหน่งปัจจุบันได้';
        if (err.code === err.PERMISSION_DENIED) {
          errorMsg = 'กรุณาอนุญาต Location Permission ในเบราว์เซอร์เพื่อใช้งาน GPS';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          errorMsg = 'สัญญาณ GPS ไม่พร้อมใช้งาน';
        } else if (err.code === err.TIMEOUT) {
          errorMsg = 'หมดเวลารอพิกัด GPS กรุณาลองใหม่อีกครั้ง';
        }
        alert(errorMsg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleSelectOrigin = (item: PlaceSuggestion) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    setOrigin({ lat, lon });
    const shortName = item.display_name.split(',').slice(0, 3).join(', ');
    setOriginName(shortName);
    setShowOriginDropdown(false);
  };

  const handleSelectDestination = (item: PlaceSuggestion) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    setDestination({ lat, lon });
    const shortName = item.display_name.split(',').slice(0, 3).join(', ');
    setDestinationName(shortName);
    setShowDestDropdown(false);
  };

  const handleSwapLocations = () => {
    const tempOrigin = { ...origin };
    const tempOriginName = originName;
    setOrigin(destination);
    setOriginName(destinationName);
    setDestination(tempOrigin);
    setDestinationName(tempOriginName);
  };

  // ยิง API ตรวจสอบเส้นทางพร้อมเวลาออกเดินทาง (มีระบบ Fallback ไปวิเคราะห์ตรงจากเบราว์เซอร์อัตโนมัติ)
  const handleCheckRain = async () => {
    setLoading(true);
    try {
      let resultData: RouteAnalysis | null = null;

      // 1. ลองเชื่อมต่อ API บน Render ก่อน (ตั้ง Timeout 6 วินาที ป้องกันกรณี Render กำลังหลับ Cold Start)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch('https://rain-radar.onrender.com/api/analyze-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin,
            destination,
            sampleIntervalKm: 4,
            departureOffsetMin,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json();
          if (json.status === 'success' && json.data) {
            resultData = json.data;
          } else {
            console.warn('Render API returned non-success (e.g. 429 Rate Limit):', json.message);
          }
        } else {
          console.warn(`Render API returned HTTP status ${res.status}`);
        }
      } catch (backendErr: any) {
        console.warn('Render API connection skipped/timeout:', backendErr.message);
      }

      // 2. ถ้า Render ติด 429 Rate Limit หรือเซิร์ฟเวอร์หลับ ให้สลับมาวิเคราะห์ในเบราว์เซอร์ผู้ใช้ทันที (Client-Side Fallback)
      if (!resultData) {
        resultData = await analyzeRouteClientSide(origin, destination, 4, departureOffsetMin);
      }

      setData(resultData);
      if (isMobile) {
        setIsDrawerCollapsed(true);
      }
    } catch (err: any) {
      alert('ไม่สามารถตรวจสอบเส้นทางได้: ' + (err?.message || 'เกิดข้อผิดพลาดในการดึงข้อมูล'));
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    if (status === 'DANGER') return '#ef4444';
    if (status === 'WARNING') return '#f59e0b';
    return '#10b981';
  };

  const getStatusText = (status: string) => {
    if (status === 'DANGER') return 'เสี่ยงฝนตก 🌧️';
    if (status === 'WARNING') return 'ระวังละอองฝน 🌦️';
    return 'ถนนแห้ง ปลอดภัย ☀️';
  };

  const polylinePositions =
    data?.routeGeometry?.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]) || [];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        height: '100vh',
        width: '100vw',
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ================= แผงควบคุม (เมื่อเริ่มนำทางจะซ่อนกล่องนี้ทิ้งเพื่อให้เห็นแต่เรากับแมพ) ================= */}
      {!isTracking && (
        <div
          style={
            isMobile
              ? {
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  zIndex: 1000,
                  backgroundColor: '#ffffff',
                  borderTopLeftRadius: '22px',
                  borderTopRightRadius: '22px',
                  boxShadow: '0 -8px 30px rgba(0,0,0,0.22)',
                  maxHeight: isDrawerCollapsed ? '76px' : '82vh',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                }
              : {
                  width: '420px',
                  minWidth: '390px',
                  height: '100vh',
                  borderRight: '1px solid #e2e8f0',
                  boxSizing: 'border-box',
                  backgroundColor: '#ffffff',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: '2px 0 12px rgba(0,0,0,0.06)',
                  zIndex: 10,
                  overflow: 'hidden',
                }
          }
        >
        {/* Mobile Header / Grab Handle */}
        {isMobile && (
          <div
            onClick={() => setIsDrawerCollapsed(!isDrawerCollapsed)}
            style={{
              padding: '10px 16px 8px 16px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              userSelect: 'none',
              borderBottom: isDrawerCollapsed ? 'none' : '1px solid #f1f5f9',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '5px',
                backgroundColor: '#cbd5e1',
                borderRadius: '3px',
                marginBottom: '8px',
              }}
            />

            {/* แถบสรุปด่วนสำหรับดูบนที่จับมือถือหน้ารถ (เมื่อย่อลง) */}
            {isDrawerCollapsed && (
              <div
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}
              >
                {data ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        backgroundColor: getStatusColor(data.summary.status),
                        color: 'white',
                        padding: '4px 10px',
                        borderRadius: '14px',
                        fontSize: '0.82rem',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getStatusText(data.summary.status)}
                    </span>
                    <span style={{ fontSize: '0.82rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {data.summary.departureTime ? `🕒 ${data.summary.departureTime} น. • ` : ''}
                      {data.summary.totalDistanceKm} กม. • ฝน {data.summary.maxRainProbability}%
                    </span>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 600 }}>
                    {isTracking ? '🟢 กำลังติดตามรถแบบสด' : '🏍️ แตะเพื่อเปิดแผงเลือกเส้นทาง'}
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsDrawerCollapsed(false);
                  }}
                  style={{
                    backgroundColor: '#eff6ff',
                    color: '#2563eb',
                    border: '1px solid #bfdbfe',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ⚙️ ตั้งค่า
                </button>
              </div>
            )}
          </div>
        )}

        {/* เนื้อหาฟอร์มและผลการวิเคราะห์ */}
        {(!isMobile || !isDrawerCollapsed) && (
          <>
            <div
              style={{
                flex: 1,
                padding: isMobile ? '12px 18px 20px 18px' : '0',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
            {/* หัวข้อ */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.5rem' }}>🏍️</span>
                <div>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>
                    Moto Rain Radar
                  </h2>
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>เรดาร์ฝนสำหรับมอเตอร์ไซค์ (PWA)</div>
                </div>
              </div>
              {isMobile && (
                <button
                  onClick={() => setIsDrawerCollapsed(true)}
                  style={{
                    backgroundColor: '#f1f5f9',
                    border: 'none',
                    borderRadius: '50%',
                    width: '32px',
                    height: '32px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    color: '#64748b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="ย่อลงเพื่อดูแผนที่"
                >
                  ✕
                </button>
              )}
            </div>

            {/* แถบเปิด/ปิดระบบนำทางสด (Live Navigation GPS) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderRadius: '12px',
                backgroundColor: isTracking ? '#ecfdf5' : '#f8fafc',
                border: `1.5px solid ${isTracking ? '#10b981' : '#e2e8f0'}`,
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.3rem' }}>🧭</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: isTracking ? '#047857' : '#1e293b' }}>
                    {isTracking ? 'โหมดนำทางสด (Live GPS)' : 'ติดตามการเคลื่อนที่แบบสด'}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {isTracking
                      ? `หมุนตามหน้ารถอัตโนมัติ${liveLocation && liveLocation.speed ? ` • ${liveLocation.speed} กม./ชม.` : ''}`
                      : 'เหมือน Google Maps วิ่งตามตำแหน่งรถ'}
                  </div>
                </div>
              </div>
              <button
                onClick={toggleTracking}
                style={{
                  padding: '7px 14px',
                  borderRadius: '20px',
                  border: 'none',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  backgroundColor: isTracking ? '#ef4444' : '#2563eb',
                  color: 'white',
                  boxShadow: isTracking
                    ? '0 2px 8px rgba(239,68,68,0.3)'
                    : '0 2px 8px rgba(37,99,235,0.3)',
                }}
              >
                {isTracking ? '🛑 หยุด' : '▶️ เริ่มนำทาง'}
              </button>
            </div>

            {/* ช่องจุดเริ่มต้น */}
            <div ref={originInputRef} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '0.85rem', color: '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#10b981' }}></span>
                  จุดเริ่มต้น
                </label>
                <button
                  onClick={handleGetCurrentLocation}
                  disabled={isGpsLoading}
                  style={{
                    fontSize: '0.8rem',
                    backgroundColor: isGpsLoading ? '#94a3b8' : '#ecfdf5',
                    color: isGpsLoading ? '#ffffff' : '#047857',
                    border: '1px solid #a7f3d0',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    cursor: isGpsLoading ? 'not-allowed' : 'pointer',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                  title="ใช้ตำแหน่งปัจจุบันจาก GPS"
                >
                  {isGpsLoading ? '⏳ กำลังหา...' : '📍 ตำแหน่งปัจจุบัน'}
                </button>
              </div>

              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  placeholder="พิมพ์ชื่อสถานที่ เช่น BTS หมอชิต..."
                  value={originName}
                  onChange={(e) => {
                    setOriginName(e.target.value);
                    setShowOriginDropdown(true);
                  }}
                  onFocus={() => setShowOriginDropdown(true)}
                  style={{
                    width: '100%',
                    padding: '11px 36px 11px 12px',
                    border: '1.5px solid #cbd5e1',
                    borderRadius: '10px',
                    fontSize: '0.95rem',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                {originName && (
                  <button
                    onClick={() => {
                      setOriginName('');
                      setOriginSuggestions([]);
                    }}
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'transparent',
                      border: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      padding: '4px',
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Dropdown ผลค้นหา Origin */}
              {showOriginDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    backgroundColor: 'white',
                    border: '1px solid #e2e8f0',
                    borderRadius: '10px',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
                    marginTop: '4px',
                    zIndex: 1100,
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}
                >
                  {isSearchingOrigin && (
                    <div style={{ padding: '10px', fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
                      🔍 กำลังค้นหา...
                    </div>
                  )}
                  {!isSearchingOrigin && originSuggestions.length === 0 && originName.length >= 2 && (
                    <div style={{ padding: '10px', fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center' }}>
                      ไม่พบสถานที่ ลองพิมพ์ชื่อให้ชัดเจนขึ้น
                    </div>
                  )}
                  {originSuggestions.map((item) => (
                    <div
                      key={item.place_id}
                      onClick={() => handleSelectOrigin(item)}
                      style={{
                        padding: '10px 12px',
                        cursor: 'pointer',
                        fontSize: '0.88rem',
                        borderBottom: '1px solid #f1f5f9',
                        lineHeight: '1.3',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>
                        📍 {item.display_name.split(',')[0]}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.display_name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ปุ่มสลับต้นทาง-ปลายทาง */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={handleSwapLocations}
                style={{
                  padding: '5px 14px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: '20px',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: '#475569',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                ⇅ สลับจุดเริ่มต้นและปลายทาง
              </button>
            </div>

            {/* ช่องจุดปลายทาง */}
            <div ref={destInputRef} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '0.85rem', color: '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#ef4444' }}></span>
                  จุดปลายทาง
                </label>
              </div>

              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  placeholder="พิมพ์ชื่อสถานที่ เช่น ฟิวเจอร์พาร์ค..."
                  value={destinationName}
                  onChange={(e) => {
                    setDestinationName(e.target.value);
                    setShowDestDropdown(true);
                  }}
                  onFocus={() => setShowDestDropdown(true)}
                  style={{
                    width: '100%',
                    padding: '11px 36px 11px 12px',
                    border: '1.5px solid #cbd5e1',
                    borderRadius: '10px',
                    fontSize: '0.95rem',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                {destinationName && (
                  <button
                    onClick={() => {
                      setDestinationName('');
                      setDestSuggestions([]);
                    }}
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'transparent',
                      border: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      padding: '4px',
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Dropdown ผลค้นหา Destination */}
              {showDestDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    backgroundColor: 'white',
                    border: '1px solid #e2e8f0',
                    borderRadius: '10px',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
                    marginTop: '4px',
                    zIndex: 1100,
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}
                >
                  {isSearchingDest && (
                    <div style={{ padding: '10px', fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
                      🔍 กำลังค้นหา...
                    </div>
                  )}
                  {!isSearchingDest && destSuggestions.length === 0 && destinationName.length >= 2 && (
                    <div style={{ padding: '10px', fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center' }}>
                      ไม่พบสถานที่ ลองพิมพ์ชื่อให้ชัดเจนขึ้น
                    </div>
                  )}
                  {destSuggestions.map((item) => (
                    <div
                      key={item.place_id}
                      onClick={() => handleSelectDestination(item)}
                      style={{
                        padding: '10px 12px',
                        cursor: 'pointer',
                        fontSize: '0.88rem',
                        borderBottom: '1px solid #f1f5f9',
                        lineHeight: '1.3',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>
                        📍 {item.display_name.split(',')[0]}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.display_name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* แถบเลื่อนเวลาล่วงหน้า (Departure Time Slider) */}
            <div
              style={{
                backgroundColor: '#f8fafc',
                borderRadius: '12px',
                padding: '12px 14px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 700, color: '#334155', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🕒</span> เวลาออกเดินทาง:
                </label>
                <span
                  style={{
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    color: departureOffsetMin === 0 ? '#2563eb' : '#d97706',
                    backgroundColor: departureOffsetMin === 0 ? '#eff6ff' : '#fef3c7',
                    padding: '3px 8px',
                    borderRadius: '10px',
                  }}
                >
                  {getDepartureTimeLabel(departureOffsetMin)}
                </span>
              </div>

              {/* ปุ่มลัดเลือกเวลา */}
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {[
                  { label: 'ตอนนี้', value: 0 },
                  { label: '+30 นาที', value: 30 },
                  { label: '+1 ชม.', value: 60 },
                  { label: '+2 ชม.', value: 120 },
                  { label: '+3 ชม.', value: 180 },
                ].map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => setDepartureOffsetMin(preset.value)}
                    style={{
                      flex: 1,
                      padding: '6px 4px',
                      fontSize: '0.76rem',
                      fontWeight: 700,
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: departureOffsetMin === preset.value ? '#2563eb' : '#cbd5e1',
                      backgroundColor: departureOffsetMin === preset.value ? '#2563eb' : '#ffffff',
                      color: departureOffsetMin === preset.value ? '#ffffff' : '#475569',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {/* แถบ Slider เลือกเวลาละเอียด (0 ถึง 360 นาที = 6 ชม.) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>ตอนนี้</span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={15}
                  value={departureOffsetMin}
                  onChange={(e) => setDepartureOffsetMin(parseInt(e.target.value, 10))}
                  style={{
                    flex: 1,
                    height: '6px',
                    borderRadius: '4px',
                    accentColor: '#2563eb',
                    cursor: 'pointer',
                  }}
                />
                <span style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>+6 ชม.</span>
              </div>
            </div>

            {/* Toggle ดูพิกัดตัวเลข */}
            <div>
              <button
                onClick={() => setShowManualCoords(!showManualCoords)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                {showManualCoords ? 'ซ่อนพิกัดตัวเลข' : '⚙️ ดู / ปรับตัวเลขพิกัด Lat, Lon'}
              </button>

              {showManualCoords && (
                <div style={{ marginTop: '8px', padding: '10px', backgroundColor: '#f8fafc', borderRadius: '8px', fontSize: '0.82rem' }}>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ fontWeight: 600, color: '#047857' }}>ต้นทาง:</span> {origin.lat.toFixed(4)}, {origin.lon.toFixed(4)}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                      <input
                        type="number"
                        step="any"
                        value={origin.lat}
                        onChange={(e) => setOrigin({ ...origin, lat: parseFloat(e.target.value) || 0 })}
                        style={{ width: '50%', padding: '5px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      />
                      <input
                        type="number"
                        step="any"
                        value={origin.lon}
                        onChange={(e) => setOrigin({ ...origin, lon: parseFloat(e.target.value) || 0 })}
                        style={{ width: '50%', padding: '5px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      />
                    </div>
                  </div>
                  <div>
                    <span style={{ fontWeight: 600, color: '#b91c1c' }}>ปลายทาง:</span> {destination.lat.toFixed(4)}, {destination.lon.toFixed(4)}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                      <input
                        type="number"
                        step="any"
                        value={destination.lat}
                        onChange={(e) => setDestination({ ...destination, lat: parseFloat(e.target.value) || 0 })}
                        style={{ width: '50%', padding: '5px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      />
                      <input
                        type="number"
                        step="any"
                        value={destination.lon}
                        onChange={(e) => setDestination({ ...destination, lon: parseFloat(e.target.value) || 0 })}
                        style={{ width: '50%', padding: '5px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* สรุปผลการวิเคราะห์สภาพอากาศตลอดเส้นทาง */}
            {data && (
              <div
                style={{
                  padding: '14px',
                  borderRadius: '12px',
                  backgroundColor: '#f8fafc',
                  borderLeft: `6px solid ${getStatusColor(data.summary.status)}`,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '1.05rem', fontWeight: 800, color: getStatusColor(data.summary.status) }}>
                    {getStatusText(data.summary.status)}
                  </span>
                  <span style={{ fontSize: '0.8rem', backgroundColor: '#e2e8f0', color: '#334155', padding: '3px 8px', borderRadius: '10px', fontWeight: 600 }}>
                    ฝนสูงสุด {data.summary.maxRainProbability}%
                  </span>
                </div>

                {data.summary.departureTime && (
                  <div style={{ fontSize: '0.85rem', color: '#1e293b', fontWeight: 700, marginBottom: '8px', backgroundColor: '#eff6ff', padding: '6px 10px', borderRadius: '8px', border: '1px solid #bfdbfe' }}>
                    🕒 พยากรณ์สำหรับเวลาออกเดินทาง: <strong>{data.summary.departureTime} น.</strong>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                  <div style={{ backgroundColor: 'white', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '0.72rem', color: '#64748b' }}>ระยะทางรวม</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>{data.summary.totalDistanceKm} กม.</div>
                  </div>
                  <div style={{ backgroundColor: 'white', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '0.72rem', color: '#64748b' }}>เวลาประมาณ</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>{data.summary.totalDurationMin} นาที</div>
                  </div>
                </div>

                <div
                  style={{
                    padding: '10px',
                    backgroundColor: '#ffffff',
                    borderRadius: '8px',
                    border: '1px solid #e2e8f0',
                    fontSize: '0.88rem',
                    color: '#334155',
                    lineHeight: '1.45',
                  }}
                >
                  💡 <strong>คำแนะนำ:</strong> {data.summary.recommendation}
                </div>
              </div>
            )}
          </div>

          {/* Sticky Action Footer: ปุ่มสแกนเส้นทาง ลอยอยู่ด้านล่างตลอดเวลา มองเห็นได้ทันที */}
          <div
            style={{
              position: 'sticky',
              bottom: 0,
              backgroundColor: '#ffffff',
              padding: '12px 18px max(14px, env(safe-area-inset-bottom)) 18px',
              borderTop: '1px solid #f1f5f9',
              boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
              zIndex: 50,
            }}
          >
            <button
              onClick={handleCheckRain}
              disabled={loading}
              style={{
                width: '100%',
                minHeight: '48px',
                padding: '12px',
                backgroundColor: loading ? '#93c5fd' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '14px',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontWeight: 800,
                fontSize: '1.02rem',
                boxShadow: '0 4px 14px rgba(37,99,235,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {loading ? '⏳ กำลังคำนวณและสแกนเรดาร์...' : `⚡ สแกนสภาพอากาศเส้นทาง (${getDepartureTimeLabel(departureOffsetMin)})`}
            </button>
          </div>
        </>
      )}
    </div>
  )}

      {/* ================= พื้นที่แผนที่ Leaflet ================= */}
      <div
        style={
          isMobile
            ? {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                width: '100%',
                height: '100%',
                zIndex: 1,
              }
            : {
                flex: 1,
                height: '100vh',
                position: 'relative',
                zIndex: 1,
                overflow: 'hidden',
              }
        }
      >
        <MapContainer
          center={[origin.lat, origin.lon]}
          zoom={12}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <MapController
            origin={origin}
            destination={destination}
            routeCoords={polylinePositions}
            isTracking={isTracking}
          />

          <NavigationFollower
            isTracking={isTracking}
            autoFollow={autoFollow}
            setAutoFollow={setAutoFollow}
            liveLocation={liveLocation}
            povMode={povMode}
            routeCoords={polylinePositions}
          />

          {/* จุดเริ่มต้น (🟢 Origin Marker - แสดงเมื่อไม่ได้เปิด Live Tracking) */}
          {!isTracking && (
            <CircleMarker
              center={[origin.lat, origin.lon]}
              radius={11}
              pathOptions={{
                fillColor: '#10b981',
                fillOpacity: 1,
                color: '#ffffff',
                weight: 3,
              }}
            >
              <Popup>
                <div>
                  <strong style={{ color: '#047857' }}>🟢 จุดเริ่มต้น</strong><br />
                  {originName}<br />
                  <small style={{ color: '#64748b' }}>({origin.lat.toFixed(4)}, {origin.lon.toFixed(4)})</small>
                </div>
              </Popup>
            </CircleMarker>
          )}

          {/* ไอคอนนำทางหน้ารถแบบหมุนได้ตาม coords.heading (Vehicle Live Cursor) */}
          {liveLocation && (
            <Marker
              position={[liveLocation.lat, liveLocation.lon]}
              icon={createVehicleNavIcon(liveLocation.heading)}
              zIndexOffset={1000}
            >
              <Popup>
                <div>
                  <strong style={{ color: '#2563eb' }}>🏍️ ตำแหน่งรถของคุณ (Live GPS)</strong><br />
                  {liveLocation.speed !== null && <span>ความเร็ว: <strong>{liveLocation.speed} กม./ชม.</strong><br /></span>}
                  {liveLocation.heading !== null && <span>ทิศทาง: <strong>{Math.round(liveLocation.heading)}°</strong><br /></span>}
                  ความแม่นยำ: ±{liveLocation.accuracy} เมตร
                </div>
              </Popup>
            </Marker>
          )}

          {/* จุดปลายทาง (🔴 Destination Marker) */}
          <CircleMarker
            center={[destination.lat, destination.lon]}
            radius={11}
            pathOptions={{
              fillColor: '#ef4444',
              fillOpacity: 1,
              color: '#ffffff',
              weight: 3,
            }}
          >
            <Popup>
              <div>
                <strong style={{ color: '#b91c1c' }}>🔴 จุดหมายปลายทาง</strong><br />
                {destinationName}<br />
                <small style={{ color: '#64748b' }}>({destination.lat.toFixed(4)}, {destination.lon.toFixed(4)})</small>
              </div>
            </Popup>
          </CircleMarker>

          {/* เส้นทางการขับขี่ */}
          {polylinePositions.length > 0 && (
            <Polyline positions={polylinePositions} color="#2563eb" weight={6} opacity={0.85} />
          )}

          {/* จุดตรวจสอบสภาพอากาศ (Checkpoints พร้อมเวลา ETA) */}
          {data?.checkpoints.map((pt) => (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lon]}
              radius={8}
              pathOptions={{
                fillColor: getStatusColor(pt.status),
                fillOpacity: 1,
                color: '#ffffff',
                weight: 2,
              }}
            >
              <Popup>
                <div>
                  <strong>จุดตรวจสอบที่ {pt.id}</strong><br />
                  {pt.etaTime && <span>⏱️ ถึงประมาณ: <strong>{pt.etaTime} น.</strong><br /></span>}
                  โอกาสฝนตก: <strong>{pt.rainProbability}%</strong><br />
                  ปริมาณฝน: <strong>{pt.rainAmountMm} มม.</strong><br />
                  ระดับ: <span style={{ color: getStatusColor(pt.status), fontWeight: 'bold' }}>{pt.status}</span>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        {/* ================= โหมดนำทางสดเต็มจอ (เมื่อกดเริ่มเดินทาง: ซ่อน Box เหลือแค่เรากับแมพ) ================= */}
        {isTracking && (
          <>
            {/* Top HUD: แถบสถานะความเร็วและสภาพอากาศลอยด้านบน */}
            <div
              style={{
                position: 'absolute',
                top: 'max(14px, env(safe-area-inset-top))',
                left: '12px',
                right: '12px',
                zIndex: 1000,
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                backdropFilter: 'blur(10px)',
                borderRadius: '20px',
                padding: '10px 14px',
                boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                color: '#ffffff',
              }}
            >
              {/* Digital Speedometer */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span
                  style={{
                    fontSize: '1.7rem',
                    fontWeight: 900,
                    color: '#38bdf8',
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1,
                  }}
                >
                  {liveLocation?.speed != null ? liveLocation.speed : '0'}
                </span>
                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>กม./ชม.</span>
              </div>

              {/* สรุปสภาพอากาศ & ปลายทาง */}
              <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span
                    style={{
                      backgroundColor: data ? getStatusColor(data.summary.status) : '#2563eb',
                      color: '#ffffff',
                      padding: '3px 10px',
                      borderRadius: '12px',
                      fontSize: '0.78rem',
                      fontWeight: 800,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {data ? getStatusText(data.summary.status) : '🧭 กำลังนำทาง'}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: '#cbd5e1',
                    marginTop: '2px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  🏁 {destinationName} {data ? `(${data.summary.totalDistanceKm} กม.)` : ''}
                </div>
              </div>

              {/* ปุ่มหยุดนำทาง ด่วน (นำ Box กลับมา) */}
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
                  boxShadow: '0 2px 10px rgba(239,68,68,0.4)',
                  whiteSpace: 'nowrap',
                }}
              >
                🛑 หยุด
              </button>
            </div>

            {/* Bottom Controls Bar: ปุ่มเปลี่ยน POV มุมมองคนขับ / ภาพรวม และปุ่มจัดกึ่งกลาง */}
            <div
              style={{
                position: 'absolute',
                bottom: 'max(20px, env(safe-area-inset-bottom))',
                left: '14px',
                right: '14px',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                pointerEvents: 'none',
              }}
            >
              {/* ปุ่มเปลี่ยน POV สไตล์ Google Maps (ซูมประชิดตัวรถ 17.5 VS ภาพรวมเส้นทาง) */}
              <button
                onClick={() => {
                  const nextMode = povMode === 'DRIVER' ? 'OVERVIEW' : 'DRIVER';
                  setPovMode(nextMode);
                  setAutoFollow(true);
                }}
                style={{
                  pointerEvents: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  backgroundColor: povMode === 'DRIVER' ? '#2563eb' : '#0f172a',
                  color: '#ffffff',
                  border: '2px solid rgba(255,255,255,0.25)',
                  borderRadius: '26px',
                  padding: '12px 20px',
                  fontSize: '0.92rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  boxShadow: '0 6px 22px rgba(0,0,0,0.35)',
                  transition: 'all 0.2s ease',
                }}
              >
                {povMode === 'DRIVER' ? (
                  <>
                    <span style={{ fontSize: '1.25rem' }}>🛵</span>
                    <span>มุมมองคนขับ (ซูมใกล้)</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: '1.25rem' }}>🗺️</span>
                    <span>ภาพรวมเส้นทาง</span>
                  </>
                )}
              </button>

              {/* ปุ่มล็อคกึ่งกลางรถ (Recenter) เมื่อผู้ใช้เอานิ้วเลื่อนแผนที่ไปดูที่อื่น */}
              {!autoFollow && (
                <button
                  onClick={() => {
                    setAutoFollow(true);
                    setPovMode('DRIVER');
                  }}
                  style={{
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '26px',
                    padding: '12px 18px',
                    fontSize: '0.88rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                    boxShadow: '0 6px 20px rgba(16,185,129,0.4)',
                  }}
                >
                  <span>🎯</span>
                  <span>กึ่งกลางรถ</span>
                </button>
              )}
            </div>
          </>
        )}

        {/* ปุ่มลอย Quick Actions บนแผนที่ (แสดงเฉพาะเมื่อยังไม่ได้เริ่มนำทาง) */}
        {!isTracking && (
          <div
            style={{
              position: 'absolute',
              bottom: isMobile ? (isDrawerCollapsed ? '96px' : '300px') : '24px',
              right: '16px',
              zIndex: 999,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'bottom 0.3s ease',
            }}
          >
            {/* ปุ่มเริ่มนำทางสด */}
            <button
              onClick={toggleTracking}
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: '2px solid #ffffff',
                boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.3rem',
                transition: 'all 0.2s ease',
              }}
              title="เริ่มนำทางสด"
            >
              🧭
            </button>

            {/* ปุ่มดึง GPS ด่วนครั้งเดียว */}
            <button
              onClick={handleGetCurrentLocation}
              disabled={isGpsLoading}
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: '#ffffff',
                border: '1px solid #cbd5e1',
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                cursor: isGpsLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.25rem',
              }}
              title="ดึงพิกัดปัจจุบัน"
            >
              {isGpsLoading ? '⏳' : '📍'}
            </button>

            {/* ปุ่มสลับเปิด/ปิด Drawer สำหรับมือถือ */}
            {isMobile && (
              <button
                onClick={() => setIsDrawerCollapsed(!isDrawerCollapsed)}
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  backgroundColor: '#0f172a',
                  color: '#ffffff',
                  border: 'none',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.15rem',
                }}
                title={isDrawerCollapsed ? 'เปิดแผงควบคุม' : 'ย่อแผงควบคุม'}
              >
                {isDrawerCollapsed ? '🗺️' : '⬇️'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;