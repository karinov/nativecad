import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
from openai import AsyncOpenAI

from config import (
    MINIMAX_API_KEY,
    MINIMAX_BASE_URL,
    MINIMAX_MODEL,
    EXPORT_DIR
)
from mcp_client import NativeCADManager

logger = logging.getLogger('nativecad.agent')

SYSTEM_PROMPT = f"""You are NativeCAD AI Assistant, an expert Mechanical and CAD Design Engineer powered by NativeCAD (a real B-rep solid-modelling kernel).
You have full access to NativeCAD tools over MCP.

Guidelines for Modeling & Exporting:
1. Primitives:
   - Use direct primitives like `cad_box`, `cad_cylinder`, `cad_sphere`, `cad_cone` with standard numbers.
   - Origin coordinates should be arrays of numbers, e.g. origin=[0, 0, 0].
2. Combining / Cutting:
   - Use `cad_boolean_union`, `cad_boolean_subtract`, or `cad_boolean_intersect`.
   - 'of' is the main solid handle, and 'tool' is the cutter/tool solid handle.
3. Exporting:
   - When the user asks to create or export 3D models, ALWAYS export the final resulting solid handle using `cad_export_body`.
   - Set format to 'step' and 'stl'.
   - Set path to '{EXPORT_DIR}/<filename>.<ext>', for example '{EXPORT_DIR}/model.step' and '{EXPORT_DIR}/model.stl'.
   - Pass 'handle' or 'of' with the final solid handle ID.
4. Final Explanation:
   - Provide a clear, professional explanation in Indonesian.
   - Mention the final dimensions, volume, features, and exported file paths.
"""

class CADAgent:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or MINIMAX_API_KEY
        self.client = AsyncOpenAI(
            api_key=self.api_key or 'dummy-key',
            base_url=MINIMAX_BASE_URL
        )
        self.mcp_manager = NativeCADManager.get_instance()

    async def chat(
        self,
        message: str,
        history: Optional[List[Dict[str, Any]]] = None,
        max_turns: int = 20
    ) -> Dict[str, Any]:
        if not self.api_key:
            return {
                'error': 'MiniMax API Key is not configured.',
                'response': 'MiniMax API Key belum dikonfigurasi di server.',
                'tool_calls': [],
                'exports': []
            }

        before_files = set(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else set()
        messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
        if history:
            for h in history:
                if h.get('role') in ['user', 'assistant', 'system']:
                    messages.append({'role': h['role'], 'content': str(h.get('content', ''))})
        messages.append({'role': 'user', 'content': message})

        tools = await self.mcp_manager.get_openai_tools()
        executed_tool_records = []
        turn = 0
        final_text = ''

        while turn < max_turns:
            turn += 1
            logger.info(f'LLM Turn {turn}/{max_turns} calling MiniMax {MINIMAX_MODEL}...')

            try:
                response = await self.client.chat.completions.create(
                    model=MINIMAX_MODEL,
                    messages=messages,
                    tools=tools if tools else None,
                    tool_choice='auto' if tools else None,
                    temperature=0.2
                )
            except Exception as e:
                logger.error(f'MiniMax API call failed: {e}')
                return {
                    'error': f'MiniMax API error: {str(e)}',
                    'response': f'Terjadi kesalahan saat menghubungi API MiniMax: {str(e)}',
                    'tool_calls': executed_tool_records,
                    'exports': []
                }

            choice = response.choices[0]
            msg = choice.message
            content = msg.content or ''

            if not msg.tool_calls:
                final_text = content
                break

            messages.append(msg)

            for tool_call in msg.tool_calls:
                func_name = tool_call.function.name
                call_id = tool_call.id
                raw_args = tool_call.function.arguments or '{}'

                try:
                    args = json.loads(raw_args)
                except Exception:
                    args = {}

                tool_res = await self.mcp_manager.call_tool(func_name, args)
                executed_tool_records.append({
                    'tool': func_name,
                    'arguments': args,
                    'result': tool_res
                })

                res_str = json.dumps(tool_res) if not isinstance(tool_res, str) else tool_res
                messages.append({
                    'role': 'tool',
                    'tool_call_id': call_id,
                    'content': res_str
                })

        after_files = set(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else set()
        new_files = list(after_files - before_files)

        exports = []
        for fn in new_files:
            fp = EXPORT_DIR / fn
            if fp.is_file():
                exports.append({
                    'filename': fn,
                    'url': f'/nativecad/api/exports/{fn}',
                    'size': fp.stat().st_size
                })

        return {
            'response': final_text,
            'tool_calls': executed_tool_records,
            'exports': exports,
            'turns': turn
        }

    async def chat_stream(
        self,
        message: str,
        history: Optional[List[Dict[str, Any]]] = None,
        max_turns: int = 20
    ) -> AsyncGenerator[Tuple[str, Dict[str, Any]], None]:
        if not self.api_key:
            yield ('error', {'message': 'MiniMax API Key belum dikonfigurasi.'})
            return

        queue = asyncio.Queue()

        async def pinger():
            try:
                while True:
                    await asyncio.sleep(3.5)
                    await queue.put(('ping', {'t': time.time()}))
            except asyncio.CancelledError:
                pass

        async def worker():
            try:
                await queue.put(('status', {'stage': 'init', 'text': 'Menghubungkan ke MiniMax & NativeCAD...'}))

                before_files = set(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else set()
                messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
                if history:
                    for h in history:
                        if h.get('role') in ['user', 'assistant', 'system']:
                            messages.append({'role': h['role'], 'content': str(h.get('content', ''))})
                messages.append({'role': 'user', 'content': message})

                tools = await self.mcp_manager.get_openai_tools()
                executed_tool_records = []
                turn = 0
                final_text = ''

                while turn < max_turns:
                    turn += 1
                    await queue.put(('status', {
                        'stage': 'thinking',
                        'turn': turn,
                        'text': f'AI merancang langkah geometri (Langkah {turn})...'
                    }))

                    try:
                        response = await self.client.chat.completions.create(
                            model=MINIMAX_MODEL,
                            messages=messages,
                            tools=tools if tools else None,
                            tool_choice='auto' if tools else None,
                            temperature=0.2
                        )
                    except Exception as e:
                        logger.error(f'MiniMax API stream error: {e}')
                        await queue.put(('error', {'message': f'MiniMax API Error: {str(e)}'}))
                        return

                    choice = response.choices[0]
                    msg = choice.message
                    content = msg.content or ''

                    if not msg.tool_calls:
                        final_text = content
                        await queue.put(('text', {'content': content}))
                        break

                    messages.append(msg)

                    for tool_call in msg.tool_calls:
                        func_name = tool_call.function.name
                        call_id = tool_call.id
                        raw_args = tool_call.function.arguments or '{}'

                        try:
                            args = json.loads(raw_args)
                        except Exception:
                            args = {}

                        await queue.put(('tool_start', {
                            'tool': func_name,
                            'arguments': args,
                            'text': f'Menjalankan operasi CAD: {func_name}...'
                        }))

                        tool_res = await self.mcp_manager.call_tool(func_name, args)
                        executed_tool_records.append({
                            'tool': func_name,
                            'arguments': args,
                            'result': tool_res
                        })

                        await queue.put(('tool_result', {
                            'tool': func_name,
                            'result': tool_res
                        }))

                        res_str = json.dumps(tool_res) if not isinstance(tool_res, str) else tool_res
                        messages.append({
                            'role': 'tool',
                            'tool_call_id': call_id,
                            'content': res_str
                        })

                after_files = set(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else set()
                new_files = list(after_files - before_files)

                exports = []
                for fn in new_files:
                    fp = EXPORT_DIR / fn
                    if fp.is_file():
                        exp_data = {
                            'filename': fn,
                            'url': f'/nativecad/api/exports/{fn}',
                            'size': fp.stat().st_size
                        }
                        exports.append(exp_data)
                        await queue.put(('export', exp_data))

                await queue.put(('done', {
                    'response': final_text,
                    'exports': exports,
                    'tool_calls_count': len(executed_tool_records),
                    'turns': turn
                }))

            except Exception as ex:
                logger.error(f'Worker unexpected error: {ex}')
                await queue.put(('error', {'message': str(ex)}))
            finally:
                await queue.put(None)

        ping_task = asyncio.create_task(pinger())
        worker_task = asyncio.create_task(worker())

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            ping_task.cancel()
            if not worker_task.done():
                worker_task.cancel()