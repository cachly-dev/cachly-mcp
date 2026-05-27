"""add telegram_chat_id to users

Revision ID: 0002
Revises: 0001
Create Date: 2025-01-02 00:00:00.000000
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('telegram_chat_id', sa.Text(), nullable=True))
    op.create_index('ix_users_telegram_chat_id', 'users', ['telegram_chat_id'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_users_telegram_chat_id', 'users')
    op.drop_column('users', 'telegram_chat_id')
