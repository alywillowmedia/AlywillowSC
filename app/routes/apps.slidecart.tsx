import type { LoaderFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import {
  getOrCreateSlidecartSettings,
  settingsToProxyConfig,
} from '../models.slidecart.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = context.session?.shop || url.searchParams.get('shop');

  if (!shop) {
    throw new Response('Missing shop', { status: 400 });
  }

  const settings = await getOrCreateSlidecartSettings(shop);
  return Response.json(settingsToProxyConfig(settings));
};
