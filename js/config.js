// =========================================================
// StockVoz · Configuración
// Editá estos valores, guardá y volvé a publicar (git push → Vercel).
// =========================================================
export const CONFIG = {
  VERSION: '6.3.1',

  // Supabase → Project Settings → API.
  // URL: "Project URL" (https://xxxx.supabase.co)
  // KEY: la clave pública "anon" o "publishable". NUNCA pongas la "service_role" / "secret".
  SUPABASE_URL: 'https://yltvdgvhmulewgfmzesi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdHZkZ3ZobXVsZXdnZm16ZXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2MjE5NTYsImV4cCI6MjEwODE5Nzk1Nn0.IXi7dH5SUG3ETcaFiKSqBxRS4Vzkpm_tE-rmsqQRWOk',

  // Tu WhatsApp: solo dígitos con código de país, sin + ni espacios.
  // Se usa para el botón de contacto y para que los usuarios nuevos te avisen.
  ADMIN_WHATSAPP: '5491162021005',

  // false → cualquiera usa la app en modo local; guardar en la nube requiere cuenta aprobada.
  // true  → nadie entra a la app sin una cuenta aprobada por vos.
  REQUIRE_LOGIN: false,

  // Ahorro de recursos del plan gratuito de Supabase:
  SYNC_DELAY_MS: 5000,        // agrupa los cambios: sube 1 vez, 5 s después del último movimiento
  CLOUD_HISTORY_LIMIT: 1000,  // movimientos que se guardan en la nube (los más recientes)
  PULL_INTERVAL_MS: 120000,   // al volver a la app, verifica cambios de otros dispositivos como máximo cada 2 min
  TEAM_POLL_MS: 60000,        // con la app abierta, busca cambios del equipo cada 1 min (si no hay cambios, la respuesta pesa pocos bytes)
};
