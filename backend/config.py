import os
from pathlib import Path
from dotenv import load_dotenv, set_key

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / '.env'

load_dotenv(dotenv_path=ENV_PATH)

MINIMAX_API_KEY = os.getenv('MINIMAX_API_KEY', '')
MINIMAX_BASE_URL = os.getenv('MINIMAX_BASE_URL', 'https://api.minimax.io/v1')
MINIMAX_MODEL = os.getenv('MINIMAX_MODEL', 'MiniMax-M3.1-Flash-Preview')

HOST = os.getenv('HOST', '0.0.0.0')
PORT = int(os.getenv('PORT', '8000'))
EXPORT_DIR = Path(os.getenv('EXPORT_DIR', str(BASE_DIR / 'exports')))
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

def update_minimax_api_key(new_key: str):
    global MINIMAX_API_KEY
    MINIMAX_API_KEY = new_key.strip()
    os.environ['MINIMAX_API_KEY'] = MINIMAX_API_KEY
    try:
        set_key(str(ENV_PATH), 'MINIMAX_API_KEY', MINIMAX_API_KEY)
    except Exception as e:
        print(f'Warning: Failed to persist API key to .env: {e}')
