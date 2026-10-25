import asyncio
import json
import logging
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger('nativecad.mcp')

class NativeCADManager:
    _instance: Optional['NativeCADManager'] = None

    def __init__(self):
        self._stack: Optional[AsyncExitStack] = None
        self._session: Optional[ClientSession] = None
        self._tools: List[Any] = []
        self._openai_tools: List[Dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._is_connected = False

    @classmethod
    def get_instance(cls) -> 'NativeCADManager':
        if cls._instance is None:
            cls._instance = NativeCADManager()
        return cls._instance

    @property
    def is_connected(self) -> bool:
        return self._is_connected and self._session is not None

    async def connect(self):
        async with self._lock:
            if self._is_connected and self._session is not None:
                return

            logger.info('Connecting to NativeCAD MCP server...')
            self._stack = AsyncExitStack()
            server_params = StdioServerParameters(
                command='nativecad-mcp',
                args=[],
                env={'CADSOLVER_QUIET': '1'}
            )
            read_stream, write_stream = await self._stack.enter_async_context(
                stdio_client(server_params)
            )
            self._session = await self._stack.enter_async_context(
                ClientSession(read_stream, write_stream)
            )
            await self._session.initialize()
            self._is_connected = True
            logger.info('Connected to NativeCAD MCP successfully.')

            # Cache tools
            await self._refresh_tools_internal()

    async def _refresh_tools_internal(self):
        if not self._session:
            return
        result = await self._session.list_tools()
        self._tools = result.tools
        self._openai_tools = []
        for t in self._tools:
            schema = t.input_schema if hasattr(t, 'input_schema') else {}
            self._openai_tools.append({
                'type': 'function',
                'function': {
                    'name': t.name,
                    'description': t.description or '',
                    'parameters': schema
                }
            })
        logger.info(f'Cached {len(self._openai_tools)} NativeCAD tools.')

    async def get_openai_tools(self) -> List[Dict[str, Any]]:
        if not self.is_connected:
            await self.connect()
        return self._openai_tools

    async def get_raw_tools(self) -> List[Dict[str, Any]]:
        if not self.is_connected:
            await self.connect()
        return [
            {
                'name': t.name,
                'description': t.description or '',
                'input_schema': t.input_schema if hasattr(t, 'input_schema') else {}
            }
            for t in self._tools
        ]

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        if not self.is_connected:
            await self.connect()

        async with self._lock:
            try:
                res = await self._session.call_tool(name, arguments)
                texts = []
                for content in res.content:
                    if hasattr(content, 'text'):
                        texts.append(content.text)
                    elif isinstance(content, dict) and 'text' in content:
                        texts.append(content['text'])
                    else:
                        texts.append(str(content))
                
                joined = '\n'.join(texts)
                try:
                    return json.loads(joined)
                except Exception:
                    return joined
            except Exception as e:
                logger.error(f'Error calling NativeCAD tool {name}: {e}')
                return {'error': str(e)}

    async def disconnect(self):
        async with self._lock:
            if self._stack:
                try:
                    await self._stack.aclose()
                except Exception as e:
                    logger.warning(f'Error closing stack: {e}')
                self._stack = None
                self._session = None
                self._is_connected = False
                logger.info('Disconnected from NativeCAD MCP.')

    async def restart(self):
        await self.disconnect()
        await self.connect()
