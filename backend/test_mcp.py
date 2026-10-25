import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def test():
    server_params = StdioServerParameters(
        command='nativecad-mcp',
        args=[],
        env={'CADSOLVER_QUIET': '1'}
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print(f'Connected! Found {len(tools.tools)} tools.')
            for t in tools.tools[:5]:
                desc = (t.description or '')[:60]
                print(f' - {t.name}: {desc}...')

if __name__ == '__main__':
    asyncio.run(test())
