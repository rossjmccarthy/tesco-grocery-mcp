# tesco-grocery-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps Tesco's grocery APIs, letting AI assistants like Claude search products, manage your basket, and book delivery slots.

## Tools

### Authentication

| Tool | Description |
|------|-------------|
| `set_auth_token` | Set bearer token and customer UUID from your browser session |

### Search & Browse

| Tool | Description |
|------|-------------|
| `search_products` | Search for grocery products (supports batched multi-query) |
| `get_product_details` | Get detailed info for a specific product |
| `get_offers` | Find products on promotion or Clubcard price |
| `get_substitutions` | Find alternatives for unavailable products |
| `browse_categories` | Get the department/aisle/shelf taxonomy tree |
| `get_favourites` | Get your favourite products |
| `get_order_history` | Get previous orders |

### Basket

| Tool | Description |
|------|-------------|
| `get_basket` | View current basket contents |
| `add_to_basket` | Add products. `mode: "add"` (default) adds to what is already there and never lowers a quantity, so several recipes can be combined; `mode: "set"` sets exact quantities. `dryRun` previews |
| `remove_from_basket` | Remove products from basket. `dryRun` previews |
| `undo_last_basket_change` | Put back the quantities from before the last add/remove; skips lines changed since unless `force` |

Every basket change can be previewed with `dryRun: true`: it lists each
line's quantity before and after and an estimated cost change (shelf prices;
Clubcard and multibuy prices can make the real total differ), and writes
nothing. Before each real change the previous quantities are saved to
`basket-history.json` in the config directory (mode 600, last 20 changes),
which is what `undo_last_basket_change` uses. There is no checkout tool:
placing the order stays a human step on the Tesco website.

### Delivery Slots

| Tool | Description |
|------|-------------|
| `get_delivery_slots` | View available delivery slots for a date range |
| `get_available_weeks` | See which weeks have delivery slots |
| `get_current_slot` | Check if you have a slot booked |
| `book_delivery_slot` | Book or unbook a delivery slot |

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `TESCO_REGION` | `UK` | `UK` (tesco.com, GBP) or `IE` (tesco.ie, EUR). The IE request headers are not yet confirmed against tesco.ie |
| `TESCO_LANGUAGE` | per region | Override the `language` header (`en-GB` / `en-IE`) |
| `TESCO_ENV_PATH` | config dir `.env` | Where credentials are stored |
| `TESCO_HISTORY_PATH` | config dir `basket-history.json` | Where basket changes are recorded for undo |

## Prerequisites

- Node.js >= 18
- A Tesco.com account with an active grocery session

## Installation

### Via npx (recommended)

No installation needed — just configure your MCP client (see below).

### Global install

```bash
npm install -g tesco-grocery-mcp
```

### From source

```bash
git clone https://github.com/GavinAttard/tesco-grocery-mcp.git
cd tesco-grocery-mcp
npm install
npm run build
```

## Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tesco-grocery": {
      "command": "npx",
      "args": ["-y", "tesco-grocery-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tesco-grocery -- npx -y tesco-grocery-mcp
```

### Other MCP clients

Run the server on stdio:

```bash
npx -y tesco-grocery-mcp
```

Or if installed globally:

```bash
tesco-grocery
```

## Authentication

The server requires a bearer token from an active Tesco.com session:

1. Log in to [tesco.com/groceries](https://www.tesco.com/groceries/) in your browser
2. Open DevTools (F12) → Network tab
3. Find any request to `xapi.tesco.com` and copy the `Authorization` header value and `x-customer-uuid` header value OR copy values from the oAUTH.ACCESSTOKEN and UUID cookies
4. Use the `set_auth_token` tool to provide these credentials

Credentials are persisted locally so you only need to do this when your session expires.

See [`.env.example`](.env.example) for the credential format.

## Tests

`npm test` builds and runs offline checks against a fake Tesco endpoint (no
network, no account): store headers, safe basket changes and undo, tool names,
and that nothing but MCP protocol reaches stdout.

## Preferences

When it connects, the server tells the assistant to read a DocMost page
called **Tesco Shopping Preferences** (staples, brands, aliases, things to
avoid, household size) before planning a shop, if DocMost tools are
available, and to preview recipe additions with `dryRun` before applying
them. The same rules are in the skill below.

## Shopping Skill

The [`skills/SKILL.md`](skills/SKILL.md) file contains an optimised execution guide that teaches AI assistants how to efficiently handle a full weekly grocery shop — from searching to basket management to delivery slot booking. You can use it as a system prompt or reference for your own workflows.

## License

[MIT](LICENSE)
