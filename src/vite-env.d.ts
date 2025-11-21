/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EBIRD_API_KEY?: string
  readonly VITE_OSM_CONTACT?: string
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}


