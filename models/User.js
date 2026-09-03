import mongoose from 'mongoose';
import bcrypt   from 'bcrypt';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // username — optional for backward compat with existing DB users
    // auto-derived on registration if not provided
    username: {
      type:      String,
      unique:    true,
      sparse:    true,   // allows null/undefined for old users without breaking uniqueness
      lowercase: true,
      trim:      true,
      index:     true,
    },

    email: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
      index:     true,
    },

    passwordHash: { type: String, required: true },
    role:         { type: String, enum: ['user', 'admin'], default: 'user' },
    lastLoginAt:  { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// Strip passwordHash from every JSON response — never expose it
userSchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.passwordHash; return ret; },
});

export default mongoose.model('User', userSchema);
