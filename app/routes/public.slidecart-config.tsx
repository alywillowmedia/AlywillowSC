import type { LoaderFunctionArgs } from 'react-router';
import {
  getOrCreateSlidecartSettings,
  settingsToProxyConfig,
} from '../models.slidecart.server';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function isValidShopDomain(value: string) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get('shop') || '').trim().toLowerCase();

  if (!isValidShopDomain(shop)) {
    return Response.json({ error: 'Missing or invalid shop' }, { status: 400, headers: CORS_HEADERS });
  }

  const settings = await getOrCreateSlidecartSettings(shop);
  return Response.json(settingsToProxyConfig(settings), { headers: CORS_HEADERS });
};

