# web-factory

Web Factory, the Phase 09 cloud application (`docs/web-factory.md`, ADR-0018). A Next.js
app of its own: it imports nothing from Z-Factory and has its own database.

```sh
cd apps/web-factory
cp .env.example .env            # set AUTH_SECRET (openssl rand -base64 48)
npm install                     # also generates the Prisma client
npx prisma migrate deploy       # into WEB_FACTORY_DATABASE_URL (database web_factory)
WEB_FACTORY_ADMIN_PASSWORD_FILE=./first-password npm run create-admin -- \
  --org "Acme Water" --slug acme-water --email admin@acme.example --name "Ada Admin"
npm run dev                     # http://localhost:3200
```

Gates: `npm run lint && npm run typecheck && npm test && npm run build`. The integration tests
use `WEB_FACTORY_TEST_DATABASE_URL` (database `web_factory_test`) and migrate it first.
