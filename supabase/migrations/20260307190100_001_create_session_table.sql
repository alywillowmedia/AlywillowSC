create table if not exists "Session" (
  id text primary key,
  shop text not null,
  state text not null,
  "isOnline" boolean not null default false,
  scope text,
  expires timestamptz,
  "accessToken" text not null,
  "userId" bigint,
  "firstName" text,
  "lastName" text,
  email text,
  "accountOwner" boolean not null default false,
  locale text,
  collaborator boolean default false,
  "emailVerified" boolean default false,
  "refreshToken" text,
  "refreshTokenExpires" timestamptz
);
