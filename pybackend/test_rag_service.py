"""
RAG 服务测试脚本
用于验证 FastAPI 服务和数据库是否正常工作
"""

import requests
import json
from pathlib import Path


def test_health_check(base_url: str = "http://localhost:8000"):
    """测试健康检查接口"""
    print("=" * 60)
    print("测试 1: 健康检查")
    print("=" * 60)
    
    try:
        response = requests.get(f"{base_url}/health")
        response.raise_for_status()
        print(f"✓ 健康检查成功")
        print(f"响应：{json.dumps(response.json(), indent=2, ensure_ascii=False)}")
        return True
    except Exception as e:
        print(f"✗ 健康检查失败：{e}")
        return False


def test_root_endpoint(base_url: str = "http://localhost:8000"):
    """测试根接口"""
    print("\n" + "=" * 60)
    print("测试 2: 根接口")
    print("=" * 60)
    
    try:
        response = requests.get(base_url)
        response.raise_for_status()
        print(f"✓ 根接口访问成功")
        print(f"响应：{json.dumps(response.json(), indent=2, ensure_ascii=False)}")
        return True
    except Exception as e:
        print(f"✗ 根接口访问失败：{e}")
        return False


def test_search_similar(base_url: str = "http://localhost:8000"):
    """测试相似度搜索接口"""
    print("\n" + "=" * 60)
    print("测试 3: 相似度搜索")
    print("=" * 60)
    
    # 测试代码示例（可以根据实际数据调整）
    test_code_samples = [
        "public void processData() {\n    if (data != null) {\n        // process\n    }\n}",
        "private int calculate(int a, int b) {\n    return a + b;\n}",
        "public String getName() {\n    return this.name;\n}"
    ]
    
    for i, code in enumerate(test_code_samples, 1):
        print(f"\n测试样本 {i}:")
        print(f"代码：{code[:50]}...")
        
        try:
            response = requests.post(
                f"{base_url}/api/search_similar",
                json={"target_code": code},
                headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            result = response.json()
            
            print(f"✓ 搜索成功")
            print(f"  找到记录：{result.get('found', False)}")
            if result.get('found'):
                print(f"  相似度：{result.get('similarity', 0):.4f}")
                print(f"  消息：{result.get('message', '')}")
            else:
                print(f"  相似度：{result.get('similarity', 0):.4f}")
                print(f"  消息：{result.get('message', '')}")
                
        except Exception as e:
            print(f"✗ 搜索失败：{e}")


def test_empty_code(base_url: str = "http://localhost:8000"):
    """测试空代码输入"""
    print("\n" + "=" * 60)
    print("测试 4: 空代码输入处理")
    print("=" * 60)
    
    try:
        response = requests.post(
            f"{base_url}/api/search_similar",
            json={"target_code": ""},
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        result = response.json()
        
        print(f"✓ 空代码处理成功")
        print(f"响应：{json.dumps(result, indent=2, ensure_ascii=False)}")
        return True
    except Exception as e:
        print(f"✗ 空代码处理失败：{e}")
        return False


def test_database_exists():
    """检查数据库文件是否存在"""
    print("=" * 60)
    print("预检查：数据库文件")
    print("=" * 60)
    
    db_path = Path(__file__).parent / "data" / "refactor_rag.db"
    
    if db_path.exists():
        print(f"✓ 数据库文件存在：{db_path}")
        print(f"  文件大小：{db_path.stat().st_size / 1024 / 1024:.2f} MB")
        return True
    else:
        print(f"✗ 数据库文件不存在：{db_path}")
        print(f"  请先运行：python build_db.py data/refactor_history_sample.json data/refactor_rag.db")
        return False


def main():
    """主测试函数"""
    print("\n" + "=" * 60)
    print("RAG 服务测试脚本")
    print("=" * 60)
    
    base_url = "http://localhost:8000"
    
    # 检查数据库
    db_exists = test_database_exists()
    
    # 检查服务是否运行
    print("\n" + "=" * 60)
    print("检查：FastAPI 服务是否运行")
    print("=" * 60)
    
    try:
        response = requests.get(base_url, timeout=2)
        print(f"✓ FastAPI 服务已启动")
    except requests.exceptions.ConnectionError:
        print(f"✗ FastAPI 服务未启动")
        print(f"\n请先启动服务：")
        print(f"  cd {Path(__file__).parent}")
        print(f"  python main.py")
        return
    except Exception as e:
        print(f"✗ 服务检查失败：{e}")
        return
    
    # 运行测试
    test_health_check(base_url)
    test_root_endpoint(base_url)
    test_search_similar(base_url)
    test_empty_code(base_url)
    
    print("\n" + "=" * 60)
    print("测试完成")
    print("=" * 60)


if __name__ == "__main__":
    main()
