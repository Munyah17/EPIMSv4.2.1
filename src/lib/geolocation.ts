export interface Coordinates {
  lat: number
  lng: number
}

/** Wraps the browser Geolocation API in a promise. Resolves null (never
 *  throws) if permission is denied or the device has no GPS — coordinates
 *  are always optional on the assessment forms that use this. */
export function getCurrentCoordinates(): Promise<Coordinates | null> {
  return new Promise(resolve => {
    if (!('geolocation' in navigator)) { resolve(null); return }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
}
