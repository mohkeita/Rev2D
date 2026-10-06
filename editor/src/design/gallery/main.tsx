/** Entry of editor/gallery.html. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { readColorToken } from '../index.js';
import { Gallery } from './Gallery.js';
import './gallery.css';

declare global {
  interface Window {
    /** Set when the gallery has mounted (tests wait for it); helpers the tests call in the page. */
    __r2Gallery?: { ready: boolean; readColorToken: typeof readColorToken };
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);

window.__r2Gallery = { ready: true, readColorToken };
