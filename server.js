const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  maxHttpBufferSize: 50e6 // 50MB para upload de arquivos
});
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs-extra');

const PORT = 3000;
const MONGO_URI = 'mongodb+srv://Sixxhxrx:Evaristo123@cluster01200.ctrdqci.mongodb.net/?appName=Cluster01200';
const DB_NAME = 'chatapp';

let db;
let usersCollection;
let messagesCollection;
let bannedCollection;
let reactionsCollection;

// Conectar ao MongoDB
MongoClient.connect(MONGO_URI)
  .then(client => {
    console.log('✅ Conectado ao MongoDB');
    db = client.db(DB_NAME);
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    bannedCollection = db.collection('banned');
    reactionsCollection = db.collection('reactions');
    
    // Criar índices
    usersCollection.createIndex({ username: 1 }, { unique: true }).catch(() => {});
    usersCollection.createIndex({ sessionId: 1 }).catch(() => {});
    messagesCollection.createIndex({ timestamp: -1 }).catch(() => {});
    reactionsCollection.createIndex({ messageId: 1 }).catch(() => {});
  })
  .catch(err => {
    console.error('❌ Erro ao conectar ao MongoDB:', err);
    console.log('💡 Certifique-se de que o MongoDB está rodando: mongod');
  });

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Servir página principal
app.get('/', (req, res) => {
  res.render('index');
});

// API para verificar/recuperar usuário
app.post('/api/check-user', async (req, res) => {
  try {
    const { username, sessionId } = req.body;
    
    // Verificar se usuário existe por sessionId
    if (sessionId) {
      const user = await usersCollection.findOne({ sessionId });
      if (user) {
        // Verificar se está banido
        const banned = await bannedCollection.findOne({ username: user.username });
        if (banned) {
          return res.json({ status: 'banned' });
        }
        return res.json({ status: 'existing', user });
      }
    }
    
    // Verificar se username está disponível
    if (username) {
      const exists = await usersCollection.findOne({ username });
      if (exists) {
        return res.json({ status: 'taken' });
      }
    }
    
    res.json({ status: 'available' });
  } catch (error) {
    console.error('Erro ao verificar usuário:', error);
    res.status(500).json({ error: 'Erro ao verificar usuário' });
  }
});

// Usuários online
const onlineUsers = new Map();
const typingUsers = new Map();

// Socket.IO
io.on('connection', (socket) => {
  console.log('👤 Usuário conectado:', socket.id);

  // Registrar ou recuperar usuário
  socket.on('register', async (data) => {
    try {
      const { username, avatar, sessionId } = data;
      let user;
      
      console.log('📝 Tentando registrar:', username);

      // Verificar se está banido
      const banned = await bannedCollection.findOne({ username });
      if (banned) {
        socket.emit('banned', { message: 'Você está banido do chat' });
        socket.disconnect();
        return;
      }

      // Verificar se é usuário existente
      if (sessionId) {
        user = await usersCollection.findOne({ sessionId });
        if (user) {
          console.log('✅ Usuário existente reconectado:', user.username);
          // Atualizar socketId
          await usersCollection.updateOne(
            { sessionId },
            { $set: { socketId: socket.id, lastSeen: new Date() } }
          );
          user.socketId = socket.id;
        }
      }

      // Novo usuário
      if (!user) {
        const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        user = {
          username,
          avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random`,
          socketId: socket.id,
          sessionId: newSessionId,
          isAdmin: username === 'admin',
          joinedAt: new Date(),
          lastSeen: new Date(),
          status: 'Disponível',
          messageCount: 0
        };

        const existingUser = await usersCollection.findOne({ username });
        if (existingUser) {
          socket.emit('username-taken');
          return;
        }

        await usersCollection.insertOne(user);
        console.log('✅ Novo usuário criado:', user.username);
      }

      onlineUsers.set(socket.id, user);

      // Enviar histórico de mensagens com reações
      const messages = await messagesCollection
        .find()
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();
      
      // Buscar reações para cada mensagem
      for (let msg of messages) {
        const reactions = await reactionsCollection.find({ messageId: msg._id.toString() }).toArray();
        msg.reactions = reactions;
      }
      
      socket.emit('message-history', messages.reverse());

      // Notificar todos
      socket.emit('registered', user);
      io.emit('user-joined', { username: user.username, avatar: user.avatar });
      io.emit('online-users', Array.from(onlineUsers.values()));
      
      console.log('✅ Usuário registrado com sucesso:', user.username);
    } catch (error) {
      console.error('❌ Erro ao registrar:', error);
      socket.emit('error', { message: 'Erro ao registrar usuário: ' + error.message });
    }
  });

  // Enviar mensagem
  socket.on('send-message', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      const message = {
        username: user.username,
        avatar: user.avatar,
        type: data.type || 'text',
        content: data.content,
        fileName: data.fileName,
        fileSize: data.fileSize,
        replyTo: data.replyTo,
        mentions: data.mentions || [],
        timestamp: new Date(),
        isAdmin: user.isAdmin,
        edited: false,
        reactions: []
      };

      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;

      // Atualizar contador de mensagens
      await usersCollection.updateOne(
        { username: user.username },
        { $inc: { messageCount: 1 } }
      );

      // Notificar menções
      if (data.mentions && data.mentions.length > 0) {
        data.mentions.forEach(mentionedUser => {
          const mentionedSocket = Array.from(onlineUsers.entries())
            .find(([id, u]) => u.username === mentionedUser);
          if (mentionedSocket) {
            io.to(mentionedSocket[0]).emit('mentioned', {
              by: user.username,
              message: message
            });
          }
        });
      }

      io.emit('new-message', message);

      // Parar de digitar
      typingUsers.delete(socket.id);
      io.emit('typing-users', Array.from(typingUsers.values()));
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
    }
  });

  // Usuário está digitando
  socket.on('typing', (isTyping) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    if (isTyping) {
      typingUsers.set(socket.id, user.username);
    } else {
      typingUsers.delete(socket.id);
    }

    io.emit('typing-users', Array.from(typingUsers.values()));
  });

  // Reagir a mensagem
  socket.on('react-message', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      const { messageId, emoji } = data;

      // Verificar se já reagiu
      const existing = await reactionsCollection.findOne({
        messageId,
        username: user.username
      });

      if (existing) {
        if (existing.emoji === emoji) {
          // Remover reação
          await reactionsCollection.deleteOne({ _id: existing._id });
        } else {
          // Atualizar reação
          await reactionsCollection.updateOne(
            { _id: existing._id },
            { $set: { emoji } }
          );
        }
      } else {
        // Adicionar nova reação
        await reactionsCollection.insertOne({
          messageId,
          username: user.username,
          emoji,
          timestamp: new Date()
        });
      }

      // Buscar todas as reações da mensagem
      const reactions = await reactionsCollection.find({ messageId }).toArray();
      io.emit('message-reactions', { messageId, reactions });
    } catch (error) {
      console.error('Erro ao reagir:', error);
    }
  });

  // Deletar mensagem
  socket.on('delete-message', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      const { messageId } = data;
      const message = await messagesCollection.findOne({ _id: new ObjectId(messageId) });

      if (!message) return;

      // Apenas o autor ou admin pode deletar
      if (message.username !== user.username && !user.isAdmin) return;

      await messagesCollection.deleteOne({ _id: new ObjectId(messageId) });
      await reactionsCollection.deleteMany({ messageId });

      io.emit('message-deleted', { messageId });
    } catch (error) {
      console.error('Erro ao deletar mensagem:', error);
    }
  });

  // Editar mensagem
  socket.on('edit-message', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      const { messageId, newContent } = data;
      const message = await messagesCollection.findOne({ _id: new ObjectId(messageId) });

      if (!message) return;

      // Apenas o autor pode editar
      if (message.username !== user.username) return;

      await messagesCollection.updateOne(
        { _id: new ObjectId(messageId) },
        { 
          $set: { 
            content: newContent,
            edited: true,
            editedAt: new Date()
          } 
        }
      );

      io.emit('message-edited', { messageId, newContent });
    } catch (error) {
      console.error('Erro ao editar mensagem:', error);
    }
  });

  // Atualizar status
  socket.on('update-status', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      await usersCollection.updateOne(
        { username: user.username },
        { $set: { status: data.status } }
      );

      user.status = data.status;
      onlineUsers.set(socket.id, user);

      io.emit('user-status-updated', { username: user.username, status: data.status });
      io.emit('online-users', Array.from(onlineUsers.values()));
    } catch (error) {
      console.error('Erro ao atualizar status:', error);
    }
  });

  // Atualizar avatar
  socket.on('update-avatar', async (data) => {
    try {
      const user = onlineUsers.get(socket.id);
      if (!user) return;

      await usersCollection.updateOne(
        { username: user.username },
        { $set: { avatar: data.avatar } }
      );

      user.avatar = data.avatar;
      onlineUsers.set(socket.id, user);

      // Atualizar avatar em todas as mensagens antigas
      await messagesCollection.updateMany(
        { username: user.username },
        { $set: { avatar: data.avatar } }
      );

      io.emit('user-updated', { username: user.username, avatar: data.avatar });
      io.emit('online-users', Array.from(onlineUsers.values()));
    } catch (error) {
      console.error('Erro ao atualizar avatar:', error);
    }
  });

  // Banir usuário (apenas admin)
  socket.on('ban-user', async (data) => {
    try {
      const admin = onlineUsers.get(socket.id);
      if (!admin || !admin.isAdmin) return;

      const { username } = data;
      
      // Não pode banir admin
      if (username === 'admin') {
        socket.emit('error', { message: 'Não é possível banir o administrador' });
        return;
      }
      
      // Adicionar à lista de banidos
      await bannedCollection.insertOne({ 
        username, 
        bannedBy: admin.username,
        bannedAt: new Date() 
      });

      // Remover usuário
      const userToBan = Array.from(onlineUsers.values()).find(u => u.username === username);
      if (userToBan) {
        await usersCollection.deleteOne({ username });
        onlineUsers.delete(userToBan.socketId);
        io.to(userToBan.socketId).emit('banned', { message: 'Você foi banido do chat pelo administrador' });
        io.sockets.sockets.get(userToBan.socketId)?.disconnect();
      }

      io.emit('user-banned', { username });
      io.emit('online-users', Array.from(onlineUsers.values()));
    } catch (error) {
      console.error('Erro ao banir usuário:', error);
    }
  });

  // Desbanir usuário (apenas admin)
  socket.on('unban-user', async (data) => {
    try {
      const admin = onlineUsers.get(socket.id);
      if (!admin || !admin.isAdmin) return;

      const { username } = data;
      await bannedCollection.deleteOne({ username });
      
      socket.emit('user-unbanned', { username });
    } catch (error) {
      console.error('Erro ao desbanir usuário:', error);
    }
  });

  // Listar usuários banidos (apenas admin)
  socket.on('get-banned-users', async () => {
    try {
      const admin = onlineUsers.get(socket.id);
      if (!admin || !admin.isAdmin) return;

      const banned = await bannedCollection.find().toArray();
      socket.emit('banned-users-list', banned);
    } catch (error) {
      console.error('Erro ao listar banidos:', error);
    }
  });

  // Limpar chat (apenas admin)
  socket.on('clear-chat', async () => {
    try {
      const admin = onlineUsers.get(socket.id);
      if (!admin || !admin.isAdmin) return;

      await messagesCollection.deleteMany({});
      await reactionsCollection.deleteMany({});
      
      io.emit('chat-cleared');
    } catch (error) {
      console.error('Erro ao limpar chat:', error);
    }
  });

  // Desconexão
  socket.on('disconnect', async () => {
    try {
      const user = onlineUsers.get(socket.id);
      if (user) {
        console.log('👋 Usuário desconectado:', user.username);
        await usersCollection.updateOne(
          { sessionId: user.sessionId },
          { $set: { lastSeen: new Date() } }
        );
        onlineUsers.delete(socket.id);
        typingUsers.delete(socket.id);
        io.emit('user-left', { username: user.username });
        io.emit('online-users', Array.from(onlineUsers.values()));
        io.emit('typing-users', Array.from(typingUsers.values()));
      }
    } catch (error) {
      console.error('Erro ao desconectar:', error);
    }
  });
});

http.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📁 MongoDB: ${MONGO_URI}`);
  console.log(`💬 Database: ${DB_NAME}`);
  console.log(`👑 Admin username: admin`);
});
