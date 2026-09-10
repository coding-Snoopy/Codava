"""
FastAPI RAG 检索服务
提供代码相似度匹配接口，用于前端获取 Few-Shot 参考示例
"""

import sys
import io

# 设置标准输出为 UTF-8 编码（修复 Windows 终端中文乱码）
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import json
import sqlite3
import numpy as np
from pathlib import Path
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel
import torch


class SearchRequest(BaseModel):
    target_code: str


class SearchResponse(BaseModel):
    found: bool
    before_code: Optional[str] = None
    after_code: Optional[str] = None
    similarity: Optional[float] = None
    message: Optional[str] = None


class AppConfig:
    def __init__(self):
        self.tokenizer = None
        self.model = None
        self.db_path = None
        self.similarity_threshold = 0.8


config = AppConfig()


def load_codebert_model():
    """加载 CodeBERT 模型和分词器"""
    print("正在加载 CodeBERT 模型...")
    tokenizer = AutoTokenizer.from_pretrained("microsoft/codebert-base")
    model = AutoModel.from_pretrained("microsoft/codebert-base")
    model.eval()
    print("CodeBERT 模型加载完成")
    return tokenizer, model


def extract_code_vector(code: str, tokenizer, model) -> np.ndarray:
    """
    使用 CodeBERT 提取代码的特征向量
    返回一维浮点数组（CLS token 的 embedding）
    """
    inputs = tokenizer(code, return_tensors="pt", truncation=True, max_length=512, padding=True)
    
    with torch.no_grad():
        outputs = model(**inputs)
    
    cls_vector = outputs.last_hidden_state[:, 0, :].squeeze().numpy()
    return cls_vector


def cosine_similarity(vec1: np.ndarray, vec2: np.ndarray) -> float:
    """计算两个向量的余弦相似度"""
    dot_product = np.dot(vec1, vec2)
    norm1 = np.linalg.norm(vec1)
    norm2 = np.linalg.norm(vec2)
    
    if norm1 == 0 or norm2 == 0:
        return 0.0
    
    return float(dot_product / (norm1 * norm2))


def load_all_vectors_from_db(db_path: str):
    """从数据库加载所有记录的向量"""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT id, before_code, after_code, before_code_vector 
        FROM refactor_examples
    ''')
    
    records = []
    for row in cursor.fetchall():
        record_id, before_code, after_code, vector_json = row
        vector = np.array(json.loads(vector_json))
        records.append({
            'id': record_id,
            'before_code': before_code,
            'after_code': after_code,
            'vector': vector
        })
    
    conn.close()
    return records


def find_most_similar(target_vector: np.ndarray, db_records: list) -> tuple:
    """
    在数据库记录中找到最相似的记录
    返回 (最相似记录，相似度分数)
    """
    if not db_records:
        return None, 0.0
    
    max_similarity = -1.0
    most_similar_record = None
    
    for record in db_records:
        similarity = cosine_similarity(target_vector, record['vector'])
        if similarity > max_similarity:
            max_similarity = similarity
            most_similar_record = record
    
    return most_similar_record, max_similarity


def init_app():
    """初始化应用配置"""
    config.tokenizer, config.model = load_codebert_model()
    
    db_path = Path(__file__).parent / "data" / "refactor_rag.db"
    config.db_path = str(db_path)
    
    if not Path(config.db_path).exists():
        print(f"警告：数据库文件不存在 {config.db_path}")
    else:
        print(f"数据库已加载：{config.db_path}")


app = FastAPI(title="RAG Code Refactoring Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    """应用启动时初始化"""
    init_app()


@app.get("/")
async def root():
    return {"message": "RAG Code Refactoring Service is running"}


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "model_loaded": config.model is not None,
        "db_exists": Path(config.db_path).exists() if config.db_path else False
    }


@app.post("/api/search_similar", response_model=SearchResponse)
async def search_similar(request: SearchRequest):
    """
    搜索与目标代码最相似的历史重构记录
    
    Args:
        request: 包含目标代码的请求体
        
    Returns:
        相似度最高的重构记录（如果相似度超过阈值）
    """
    if not request.target_code or not request.target_code.strip():
        return SearchResponse(
            found=False,
            message="目标代码为空"
        )
    
    if config.tokenizer is None or config.model is None:
        raise HTTPException(status_code=503, detail="模型未加载")
    
    if not Path(config.db_path).exists():
        raise HTTPException(status_code=503, detail="数据库未初始化")
    
    try:
        target_vector = extract_code_vector(
            request.target_code, 
            config.tokenizer, 
            config.model
        )
        
        db_records = load_all_vectors_from_db(config.db_path)
        
        if not db_records:
            return SearchResponse(
                found=False,
                message="数据库中没有可用的重构记录"
            )
        
        most_similar, similarity = find_most_similar(target_vector, db_records)
        
        if similarity >= config.similarity_threshold:
            return SearchResponse(
                found=True,
                before_code=most_similar['before_code'],
                after_code=most_similar['after_code'],
                similarity=similarity,
                message=f"找到相似记录，相似度：{similarity:.4f}"
            )
        else:
            return SearchResponse(
                found=False,
                similarity=similarity,
                message=f"未找到足够相似的记录（最高相似度：{similarity:.4f}，阈值：{config.similarity_threshold}）"
            )
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检索失败：{str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
