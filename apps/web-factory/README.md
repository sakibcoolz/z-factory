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

A broker for development (Mosquitto with Dynamic Security, ADR-0019):

```sh
printf '%s\n' "$(openssl rand -base64 18)" > ./mqtt-admin-password
docker run -d --name web-factory-broker -e MOSQUITTO_DYNSEC_PASSWORD="$(cat ./mqtt-admin-password)" \
  -p 127.0.0.1:1883:1883 -v "$PWD/broker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" eclipse-mosquitto:2
# .env: WEB_FACTORY_MQTT_URL=mqtt://127.0.0.1:1883  WEB_FACTORY_MQTT_USERNAME=admin
#       WEB_FACTORY_MQTT_PASSWORD_FILE=./mqtt-admin-password
```

Then issue each agent's credentials on its page in Web Factory.

Gates: `npm run lint && npm run typecheck && npm test && npm run build`. The integration tests
use `WEB_FACTORY_TEST_DATABASE_URL` (database `web_factory_test`) and migrate it first. The
broker and telemetry end-to-end tests need Docker (`WEB_FACTORY_TEST_DOCKER=1`) and, for the
real agent, `AGENT_BIN`.
