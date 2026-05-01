#!/usr/bin/env python3
"""tokengift CLI for public-key gifting workflow.

Commands
- keygen: generate RSA key pair.
- encrypt/gift: encrypt input text with recipient public key.
- decrypt/open: decrypt payload with private key.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)

HELP = """\
tokengift - 与他人安全交换配置的通用命令行

用法:
  tokengift keygen   [--public keys/bob_public.pem] [--private keys/bob_private.pem] [--bits 4096]
  tokengift encrypt  --public keys/bob_public.pem --text "..." --out out/tokengift.payload
  tokengift encrypt  --public keys/bob_public.pem --in config.json
  tokengift decrypt  --private keys/bob_private.pem --in out/tokengift.payload
  tokengift decrypt  --private keys/bob_private.pem --text <payload>

别名:
  tokengift gift -> encrypt
  tokengift open -> decrypt

示例（用于 tokenSwap 配置赠予）:
  1) 生成对方公私钥对（你保留私钥）
     tokengift keygen --public bob.pub.pem --private bob.private.pem

  2) 用对方公钥加密配置，得到可挂到链接中的字符串
     tokengift gift --public bob.pub.pem --in ./config.json > gift.txt

  3) 对方拿到密文后用私钥解密
     tokengift open --private bob.private.pem --in gift.txt

支持算法：RSA + OAEP(SHA-256)
输出默认使用 Base64URL 编码，支持一次写入到 URL。"""


def _to_base64_url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _from_base64_url(value: str) -> bytes:
    normalized = value.replace("-", "+").replace("_", "/")
    padding = (4 - (len(normalized) % 4)) % 4
    return base64.b64decode(normalized + ("=" * padding), validate=False)


def _read_input(options: dict[str, str | None]) -> str:
    if options.get("text") is not None:
        return str(options["text"])

    input_path = options.get("in")
    if input_path:
        return Path(input_path).read_text(encoding="utf-8")

    return sys.stdin.read()


def _write_output(text: str, options: dict[str, str | None]) -> None:
    output_path = options.get("out")
    if output_path:
        path = Path(output_path)
        if path.parent != Path("."):
            path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(f"{text}\n")


def _parse_args(argv: list[str]) -> dict[str, str | bool | None]:
    options: dict[str, str | bool | None] = {"help": False}
    positionals: list[str] = []
    i = 0

    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--"):
            if arg in ("--help", "-h"):
                options["help"] = True
                i += 1
                continue

            if i + 1 >= len(argv):
                raise ValueError(f"参数 {arg} 缺少值")

            value = argv[i + 1]
            key = arg[2:]
            options[key] = value
            i += 2
            continue

        if arg.startswith("-"):
            if i + 1 >= len(argv):
                raise ValueError(f"参数 {arg} 缺少值")

            value = argv[i + 1]
            if arg == "-p":
                options["public"] = value
                i += 2
                continue
            if arg == "-k":
                options["private"] = value
                i += 2
                continue
            if arg in ("-i", "-in"):
                options["in"] = value
                i += 2
                continue
            if arg == "-o":
                options["out"] = value
                i += 2
                continue
            if arg == "-t":
                options["text"] = value
                i += 2
                continue

            raise ValueError(f"不支持的参数 {arg}")

        positionals.append(arg)
        i += 1

    if not positionals and not options.get("help"):
        raise ValueError("缺少子命令：keygen/encrypt/decrypt")

    if positionals:
        options["_cmd"] = positionals[0]

    return options


def _split_chunks(data: bytes, chunk_size: int) -> list[bytes]:
    return [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]


def _compute_max_plaintext_len(key_size_bytes: int, hash_len: int = 32) -> int:
    max_len = key_size_bytes - 2 * hash_len - 2
    return max(1, max_len)


def _load_public_key(public_key_path: str):
    return load_pem_public_key(Path(public_key_path).read_bytes(), backend=default_backend())


def _load_private_key(private_key_path: str):
    return load_pem_private_key(
        Path(private_key_path).read_bytes(), password=None, backend=default_backend()
    )


def _encrypt(public_key_path: str, plain_text: str) -> str:
    public_key = _load_public_key(public_key_path)
    key_size_bytes = (public_key.key_size + 7) // 8
    max_chunk = _compute_max_plaintext_len(key_size_bytes, 32)

    cipher = padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None,
    )

    input_bytes = plain_text.encode("utf-8")
    chunks = _split_chunks(input_bytes, max_chunk)

    encrypted_parts = [
        _to_base64_url(public_key.encrypt(part, cipher))
        for part in chunks
    ]
    return ".".join(encrypted_parts)


def _decrypt(private_key_path: str, payload: str) -> str:
    private_key = _load_private_key(private_key_path)
    cipher = padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None,
    )

    parts = [p for p in payload.split(".") if p]
    if not parts:
        raise ValueError("解密输入为空")

    plaintext = bytearray()
    for part in parts:
        block = _from_base64_url(part)
        plaintext.extend(private_key.decrypt(block, cipher))

    return bytes(plaintext).decode("utf-8")


def _command_keygen(options: dict[str, str | bool | None]) -> None:
    bits = int(options.get("bits", 4096) or 4096)
    public_path = Path(str(options.get("public", "./keys/tokengift-public.pem")))
    private_path = Path(str(options.get("private", "./keys/tokengift-private.pem")))

    if bits < 2048:
        bits = 4096

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    public_key = private_key.public_key()

    private_pem = private_key.private_bytes(
        Encoding.PEM,
        PrivateFormat.PKCS8,
        NoEncryption(),
    )
    public_pem = public_key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)

    if public_path.parent != Path("."):
        public_path.parent.mkdir(parents=True, exist_ok=True)
    if private_path.parent != Path("."):
        private_path.parent.mkdir(parents=True, exist_ok=True)

    public_path.write_bytes(public_pem)
    private_path.write_bytes(private_pem)

    sys.stdout.write(f"已生成：\npublic={public_path}\nprivate={private_path}\n")


def _command_encrypt(options: dict[str, str | bool | None]) -> None:
    public_key_path = options.get("public")
    if not public_key_path:
        raise ValueError("加密需要 --public/ -p 公钥路径")

    plain_text = _read_input(options)
    if not plain_text:
        raise ValueError("加密输入为空")
    if not plain_text.strip():
        raise ValueError("加密输入为空")

    payload = _encrypt(str(public_key_path), plain_text)
    _write_output(payload, options)


def _command_decrypt(options: dict[str, str | bool | None]) -> None:
    private_key_path = options.get("private")
    if not private_key_path:
        raise ValueError("解密需要 --private/ -k 私钥路径")

    payload = _read_input(options).strip()
    if not payload:
        raise ValueError("解密输入为空")

    plain_text = _decrypt(str(private_key_path), payload)
    _write_output(plain_text, options)


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    try:
        options = _parse_args(argv)
        command = str(options.get("_cmd", "")).lower() if options.get("_cmd") else ""

        if options.get("help"):
            sys.stdout.write(HELP)
            return 0

        if command == "gift":
            _command_encrypt(options)
            return 0
        if command == "open":
            _command_decrypt(options)
            return 0

        if command == "keygen":
            _command_keygen(options)
            return 0
        if command == "encrypt":
            _command_encrypt(options)
            return 0
        if command == "decrypt":
            _command_decrypt(options)
            return 0

        raise ValueError(f"不支持的子命令：{command}")
    except Exception as error:
        sys.stderr.write(f"[tokengift] {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
