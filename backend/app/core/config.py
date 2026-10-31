from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://studio:studio@postgres:5432/studio"
    redis_url: str = "redis://redis:6379/0"

    jwt_secret: str = "dev-change-me"
    jwt_algorithm: str = "HS256"
    access_ttl_minutes: int = 15
    refresh_ttl_days: int = 30
    refresh_cookie: str = "studio_refresh"
    cookie_path: str = "/studio"
    cookie_secure: bool = False

    data_dir: str = "/data"
    # Host path of data_dir (needed when the worker asks the host Docker daemon
    # to bind-mount a compile directory into a sibling container).
    host_data_dir: str = "/home/sgtech/proj/latex-studio/data"
    root_path: str = "/studio"

    compile_image: str = "tectonic-prod:0.17.0"
    # Full TeX Live image used for pdflatex/xelatex/lualatex projects. Tectonic
    # is XeTeX-based and cannot run pdfTeX-only classes (e.g. ieeeaccess.cls).
    compile_texlive_image: str = "overleaf-latex-full:6.3.2"
    # Tectonic may need to fetch resources on the first run of a document.
    compile_timeout_seconds: int = 600
    compile_memory: str = "2g"
    compile_cpus: float = 2.0
    compile_pids: int = 256

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5-5"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_api_key: str = ""
    ollama_model: str = "qwen3:8b"


settings = Settings()
